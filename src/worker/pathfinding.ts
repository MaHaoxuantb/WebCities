import type { RoadEdge, RoadNode, Route } from "../shared/types";

export interface PathNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
  adjacency: number[][];
  networkVersion: number;
}

class MinPriorityQueue {
  private heap: Array<{ nodeId: number; distance: number }> = [];

  get size() {
    return this.heap.length;
  }

  push(nodeId: number, distance: number) {
    this.heap.push({ nodeId, distance });
    this.bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) {
      return null;
    }

    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(index: number) {
    let currentIndex = index;

    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);
      if (this.heap[parentIndex].distance <= this.heap[currentIndex].distance) {
        break;
      }

      [this.heap[parentIndex], this.heap[currentIndex]] = [
        this.heap[currentIndex],
        this.heap[parentIndex]
      ];
      currentIndex = parentIndex;
    }
  }

  private bubbleDown(index: number) {
    let currentIndex = index;

    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = currentIndex;

      if (
        leftIndex < this.heap.length &&
        this.heap[leftIndex].distance < this.heap[smallestIndex].distance
      ) {
        smallestIndex = leftIndex;
      }

      if (
        rightIndex < this.heap.length &&
        this.heap[rightIndex].distance < this.heap[smallestIndex].distance
      ) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === currentIndex) {
        return;
      }

      [this.heap[currentIndex], this.heap[smallestIndex]] = [
        this.heap[smallestIndex],
        this.heap[currentIndex]
      ];
      currentIndex = smallestIndex;
    }
  }
}

const reconstructRoute = (
  originNodeId: number,
  destinationNodeId: number,
  previousEdge: Array<number | null>,
  edges: RoadEdge[]
): number[] => {
  const route: number[] = [];
  let nodeId = destinationNodeId;

  while (nodeId !== originNodeId) {
    const edgeId = previousEdge[nodeId];
    if (edgeId === null || edgeId === undefined) {
      return [];
    }

    route.push(edgeId);
    nodeId = edges[edgeId].fromNodeId;
  }

  return route.reverse();
};

export const findRouteBetweenNodes = (
  network: PathNetwork,
  originNodeId: number,
  destinationNodeId: number
): Route | null => {
  if (originNodeId === destinationNodeId) {
    return {
      originNodeId,
      destinationNodeId,
      edgeIds: [],
      cost: 0
    };
  }

  const distances = new Array<number>(network.nodes.length).fill(Number.POSITIVE_INFINITY);
  const previousEdge = new Array<number | null>(network.nodes.length).fill(null);
  const visited = new Array<boolean>(network.nodes.length).fill(false);
  const queue = new MinPriorityQueue();

  distances[originNodeId] = 0;
  queue.push(originNodeId, 0);

  while (queue.size > 0) {
    const next = queue.pop();
    if (!next) {
      break;
    }

    const currentNode = next.nodeId;
    if (visited[currentNode]) {
      continue;
    }

    visited[currentNode] = true;
    if (currentNode === destinationNodeId) {
      break;
    }

    for (const edgeId of network.adjacency[currentNode] ?? []) {
      const edge = network.edges[edgeId];
      const candidateDistance = distances[currentNode] + edge.travelTime;
      if (candidateDistance < distances[edge.toNodeId]) {
        distances[edge.toNodeId] = candidateDistance;
        previousEdge[edge.toNodeId] = edgeId;
        queue.push(edge.toNodeId, candidateDistance);
      }
    }
  }

  if (!Number.isFinite(distances[destinationNodeId])) {
    return null;
  }

  return {
    originNodeId,
    destinationNodeId,
    edgeIds: reconstructRoute(
      originNodeId,
      destinationNodeId,
      previousEdge,
      network.edges
    ),
    cost: distances[destinationNodeId]
  };
};

export const findBestRoute = (
  network: PathNetwork,
  originNodeIds: number[],
  destinationNodeIds: number[],
  routeCache: Map<string, Route | null>
): Route | null => {
  let bestRoute: Route | null = null;

  for (const originNodeId of originNodeIds) {
    for (const destinationNodeId of destinationNodeIds) {
      const cacheKey = `${network.networkVersion}:${originNodeId}:${destinationNodeId}`;
      let route = routeCache.get(cacheKey) ?? null;

      if (!routeCache.has(cacheKey)) {
        route = findRouteBetweenNodes(network, originNodeId, destinationNodeId);
        routeCache.set(cacheKey, route);
      }

      if (route && (!bestRoute || route.cost < bestRoute.cost)) {
        bestRoute = route;
      }
    }
  }

  return bestRoute;
};
