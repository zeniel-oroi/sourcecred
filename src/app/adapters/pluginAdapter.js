// @flow

import React, {type Node as ReactNode} from "react";
import {Graph, type NodeAddressT, type EdgeAddressT} from "../../core/graph";
import type {Assets} from "../assets";
import type {Repo} from "../../core/repo";

export type NodeDescription = React.Component<{|+address: NodeAddressT|}>;

export type EdgeType = {|
  +forwardName: string,
  +backwardName: string,
  +defaultForwardWeight: number,
  +defaultBackwardWeight: number,
  +prefix: EdgeAddressT,
|};

export type NodeType = {|
  +name: string,
  +pluralName: string,
  +prefix: NodeAddressT,
  +defaultWeight: number,
|};

export interface StaticPluginAdapter {
  name(): string;
  nodePrefix(): NodeAddressT;
  edgePrefix(): EdgeAddressT;
  nodeTypes(): NodeType[];
  edgeTypes(): EdgeType[];
  load(assets: Assets, repo: Repo): Promise<DynamicPluginAdapter>;
}

export interface DynamicPluginAdapter {
  graph(): Graph;
  nodeDescription(): NodeDescription;
  static (): StaticPluginAdapter;
}
