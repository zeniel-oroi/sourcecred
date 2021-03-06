// @flow

import {
  defaultWeightedNodeType,
  defaultWeightedEdgeType,
  defaultWeightsForAdapter,
  combineWeights,
  defaultWeightsForAdapterSet,
} from "./weights";
import {
  inserterNodeType,
  machineNodeType,
  assemblesEdgeType,
  transportsEdgeType,
  FactorioStaticAdapter,
  staticAdapterSet,
} from "../../adapters/demoAdapters";

describe("app/credExplorer/weights/weights", () => {
  describe("defaultWeightedNodeType", () => {
    it("sets default weight as specified in type", () => {
      const wnt = defaultWeightedNodeType(inserterNodeType);
      expect(wnt.weight).toEqual(wnt.type.defaultWeight);
    });
  });
  describe("defaultWeightedEdgeType", () => {
    it("sets default weights as specified in the type", () => {
      const wet = defaultWeightedEdgeType(assemblesEdgeType);
      expect(wet.forwardWeight).toEqual(wet.type.defaultForwardWeight);
      expect(wet.backwardWeight).toEqual(wet.type.defaultBackwardWeight);
    });
  });
  describe("defaultWeightsForAdapter", () => {
    it("works on the demo adapter", () => {
      const adapter = new FactorioStaticAdapter();
      const expected = {
        nodes: new Map(
          adapter.nodeTypes().map((x) => [x.prefix, defaultWeightedNodeType(x)])
        ),
        edges: new Map(
          adapter.edgeTypes().map((x) => [x.prefix, defaultWeightedEdgeType(x)])
        ),
      };
      expect(defaultWeightsForAdapter(adapter)).toEqual(expected);
    });
  });
  describe("combineWeights", () => {
    const defaultWeights = () =>
      defaultWeightsForAdapter(new FactorioStaticAdapter());
    const emptyWeights = () => ({nodes: new Map(), edges: new Map()});
    it("successfully combines WeightedTypes", () => {
      const weights1 = {
        nodes: new Map().set(
          inserterNodeType.prefix,
          defaultWeightedNodeType(inserterNodeType)
        ),
        edges: new Map().set(
          assemblesEdgeType.prefix,
          defaultWeightedEdgeType(assemblesEdgeType)
        ),
      };
      const weights2 = {
        nodes: new Map().set(
          machineNodeType.prefix,
          defaultWeightedNodeType(machineNodeType)
        ),
        edges: new Map().set(
          transportsEdgeType.prefix,
          defaultWeightedEdgeType(transportsEdgeType)
        ),
      };
      expect(combineWeights([weights1, weights2])).toEqual(defaultWeights());
    });
    it("treats empty weights as an identity", () => {
      expect(
        combineWeights([emptyWeights(), defaultWeights(), emptyWeights()])
      ).toEqual(defaultWeights());
    });
    it("errors on duplicate edge prefix", () => {
      const weights = {
        nodes: new Map(),
        edges: new Map().set(
          assemblesEdgeType.prefix,
          defaultWeightedEdgeType(assemblesEdgeType)
        ),
      };
      expect(() => combineWeights([weights, weights])).toThrowError(
        "duplicate key"
      );
    });
    it("errors on duplicate node prefix", () => {
      const weights = {
        nodes: new Map().set(
          inserterNodeType.prefix,
          defaultWeightedNodeType(inserterNodeType)
        ),
        edges: new Map(),
      };
      expect(() => combineWeights([weights, weights])).toThrowError(
        "duplicate key"
      );
    });
  });
  describe("defaultWeightsForAdapterSet", () => {
    it("works on a demo adapter set", () => {
      expect(defaultWeightsForAdapterSet(staticAdapterSet())).toEqual(
        combineWeights(
          staticAdapterSet()
            .adapters()
            .map(defaultWeightsForAdapter)
        )
      );
    });
  });
});
