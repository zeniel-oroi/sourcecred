// @flow

import type {Address} from "../../core/address";
import type {
  Repository,
  Commit,
  Tree,
  NodePayload,
  EdgePayload,
  NodeType,
  EdgeType,
} from "./types";
import {Graph, edgeID} from "../../core/graph";
import {
  BLOB_NODE_TYPE,
  COMMIT_NODE_TYPE,
  TREE_NODE_TYPE,
  TREE_ENTRY_NODE_TYPE,
  INCLUDES_EDGE_TYPE,
  HAS_CONTENTS_EDGE_TYPE,
  HAS_TREE_EDGE_TYPE,
  GIT_PLUGIN_NAME,
  includesEdgeId,
  treeEntryId,
} from "./types";

class GitGraphCreator {
  repositoryName: string;

  constructor(repositoryName) {
    this.repositoryName = repositoryName;
  }

  makeAddress(type: NodeType | EdgeType, id: string): Address {
    return {
      pluginName: GIT_PLUGIN_NAME,
      repositoryName: this.repositoryName,
      type,
      id,
    };
  }

  createGraph(repository: Repository): Graph<NodePayload, EdgePayload> {
    const graphs = [
      ...Object.keys(repository.commits).map((hash) =>
        this.commitGraph(repository.commits[hash])
      ),
      ...Object.keys(repository.trees).map((hash) =>
        this.treeGraph(repository.trees[hash])
      ),
    ];
    return graphs.reduce((g, h) => Graph.mergeConservative(g, h), new Graph());
  }

  commitGraph(commit: Commit) {
    const commitNode = {
      address: this.makeAddress(COMMIT_NODE_TYPE, commit.hash),
      payload: {},
    };
    const treeNode = {
      address: this.makeAddress(TREE_NODE_TYPE, commit.treeHash),
      payload: {},
    };
    const edge = {
      address: this.makeAddress(
        HAS_TREE_EDGE_TYPE,
        edgeID(commitNode.address, treeNode.address)
      ),
      src: commitNode.address,
      dst: treeNode.address,
      payload: {},
    };
    return new Graph()
      .addNode(commitNode)
      .addNode(treeNode)
      .addEdge(edge);
  }

  treeGraph(tree: Tree) {
    const treeNode = {
      address: this.makeAddress(TREE_NODE_TYPE, tree.hash),
      payload: {},
    };
    const result = new Graph().addNode(treeNode);
    Object.keys(tree.entries).forEach((name) => {
      const entry = tree.entries[name];
      const entryNode = {
        address: this.makeAddress(
          TREE_ENTRY_NODE_TYPE,
          treeEntryId(tree.hash, entry.name)
        ),
        payload: {},
      };
      const entryEdge = {
        address: this.makeAddress(
          INCLUDES_EDGE_TYPE,
          includesEdgeId(tree.hash, entry.name)
        ),
        src: treeNode.address,
        dst: entryNode.address,
        payload: {},
      };
      result.addNode(entryNode).addEdge(entryEdge);
      if (entry.type === "commit") {
        // We don't represent subproject commits in the graph.
      } else {
        let contentsNodeType;
        if (entry.type === "tree") {
          contentsNodeType = TREE_NODE_TYPE;
        } else if (entry.type === "blob") {
          contentsNodeType = BLOB_NODE_TYPE;
        } else {
          // eslint-disable-next-line no-unused-expressions
          (entry.type: empty);
          throw new Error(`Unknown entry type: ${entry.type}`);
        }
        const contentsNode = {
          address: this.makeAddress(contentsNodeType, entry.hash),
          payload: {},
        };
        const contentsEdge = {
          address: this.makeAddress(
            HAS_CONTENTS_EDGE_TYPE,
            edgeID(entryNode.address, contentsNode.address)
          ),
          src: entryNode.address,
          dst: contentsNode.address,
          payload: {},
        };
        result.addNode(contentsNode).addEdge(contentsEdge);
      }
    });
    return result;
  }
}

export function createGraph(
  repository: Repository,
  repositoryName: string
): Graph<NodePayload, EdgePayload> {
  return new GitGraphCreator(repositoryName).createGraph(repository);
}