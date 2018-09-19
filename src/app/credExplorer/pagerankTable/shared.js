// @flow

import React, {type Node as ReactNode} from "react";
import {
  type EdgeAddressT,
  type NodeAddressT,
  NodeAddress,
} from "../../../core/graph";

import {DynamicAdapterSet} from "../../adapters/adapterSet";
import type {NodeDescription} from "../../adapters/pluginAdapter";

import type {PagerankNodeDecomposition} from "../../../core/attribution/pagerankNodeDecomposition";

export function nodeDescription(
  address: NodeAddressT,
  adapters: DynamicAdapterSet
): NodeDescription {
  const adapter = adapters.adapterMatchingNode(address);
  return adapter.nodeDescription();
}

export function edgeVerb(
  address: EdgeAddressT,
  direction: "FORWARD" | "BACKWARD",
  adapters: DynamicAdapterSet
): string {
  const edgeType = adapters.static().typeMatchingEdge(address);
  return direction === "FORWARD" ? edgeType.forwardName : edgeType.backwardName;
}

export type SharedProps = {|
  +pnd: PagerankNodeDecomposition,
  +adapters: DynamicAdapterSet,
  +maxEntriesPerList: number,
|};

export function Badge({children}: {children: ReactNode}): ReactNode {
  return (
    // The outer <span> acts as a strut to ensure that the badge
    // takes up a full line height, even though its text is smaller.
    <span>
      <span
        style={{
          textTransform: "uppercase",
          fontWeight: 700,
          fontSize: "smaller",
        }}
      >
        {children}
      </span>
    </span>
  );
}
