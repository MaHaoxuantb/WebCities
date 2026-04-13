import type { RoadEdge, RoadNode, Route } from "../shared/types";

export interface PathNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
  adjacency: number[][];
  networkVersion: number;
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

  distances[originNodeId] = 0;

  for (let step = 0; step < network.nodes.length; step += 1) {
    let currentNode = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let nodeIndex = 0; nodeIndex < distances.length; nodeIndex += 1) {
      if (!visited[nodeIndex] && distances[nodeIndex] < bestDistance) {
        bestDistance = distances[nodeIndex];
        currentNode = nodeIndex;
      }
    }

    if (currentNode === -1 || currentNode === destinationNodeId) {
      break;
    }

    visited[currentNode] = true;

    for (const edgeId of network.adjacency[currentNode] ?? []) {
      const edge = network.edges[edgeId];
      const candidateDistance = distances[currentNode] + edge.travelTime;
      if (candidateDistance < distances[edge.toNodeId]) {
        distances[edge.toNodeId] = candidateDistance;
        previousEdge[edge.toNodeId] = edgeId;
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
