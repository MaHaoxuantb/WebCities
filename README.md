# WebCities

Browser city simulation built with React, Pixi, and a simulation worker.

## Core Systems

### Roads and traffic

- Roads create the directed graph that all commuters, freight, and maintenance crews use.
- Congestion increases travel time, and fully loaded edges block additional trip packets from entering.
- Busy intersections still matter because queues form at shared nodes before roads fully block.

### Zoning

- Residential buildings supply population and residential income.
- Commercial and industrial buildings supply jobs, retail trips, and cargo demand.
- Buildings need road access and power to stay healthy and productive.

### Power and outages

- Power plants energize buildings through the reachable road graph.
- Buildings can suffer outages over time.
- Each power plant provides two maintenance crews, which must physically travel to the failed building.

### Budget

- The city starts with a fixed cash reserve.
- Every economy cycle, budget changes by:
  - residential income from occupied homes
  - minus road upkeep
  - minus power facility upkeep
- If infrastructure grows faster than occupied housing, the budget cycle turns negative.

## UI Notes

- Traffic, Power, and Land Stress overlays explain different bottlenecks.
- The side panels include quick tips, a systems guide, and a live budget flow breakdown.
- Autosave is stored in IndexedDB, and save files can also be imported or exported as JSON.
