import fs from 'node:fs';
import pkg from 'onnx-proto';
import { EMB, FEATURE_DIM, WINDOW } from './oww.ts';

const { onnx } = pkg;

/**
 * Saves the network as a standard .onnx, with the same shape as openWakeWord's models: input
 * [batch, 16, 96] (the last 16 features) and output [batch, 1] (0…1). It works with the
 * openWakeWord Python library or any project that runs openWakeWord models.
 *
 *   Flatten → Gemm → Relu → Gemm → Relu → … → Gemm → Sigmoid
 */
export interface Dense {
  w: Float32Array; // [input][output]
  b: Float32Array;
  inDim: number;
  outDim: number;
}

export function exportOnnx(file: string, layers: Dense[], name: string) {
  const tensor = (n: string, dims: number[], data: Float32Array) =>
    onnx.TensorProto.create({ name: n, dims, dataType: onnx.TensorProto.DataType.FLOAT, rawData: new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
  const nodes = [onnx.NodeProto.create({ opType: 'Flatten', input: ['input'], output: ['x0'], attribute: [onnx.AttributeProto.create({ name: 'axis', i: 1, type: onnx.AttributeProto.AttributeType.INT })] })];
  const inits: InstanceType<typeof onnx.TensorProto>[] = [];
  let x = 'x0';
  layers.forEach((l, i) => {
    inits.push(tensor(`w${i}`, [l.inDim, l.outDim], l.w), tensor(`b${i}`, [l.outDim], l.b));
    const last = i === layers.length - 1;
    nodes.push(onnx.NodeProto.create({ opType: 'Gemm', input: [x, `w${i}`, `b${i}`], output: [`g${i}`] }));
    nodes.push(onnx.NodeProto.create({ opType: last ? 'Sigmoid' : 'Relu', input: [`g${i}`], output: [last ? 'output' : `h${i}`] }));
    x = `h${i}`;
  });
  const dim = (v: number | string) => (typeof v === 'number' ? { dimValue: v } : { dimParam: v });
  const valueInfo = (n: string, dims: (number | string)[]) =>
    onnx.ValueInfoProto.create({ name: n, type: { tensorType: { elemType: onnx.TensorProto.DataType.FLOAT, shape: { dim: dims.map(dim) } } } });
  const model = onnx.ModelProto.create({
    irVersion: 7,
    producerName: 'wakeword-trainer',
    opsetImport: [{ domain: '', version: 13 }],
    graph: {
      name,
      node: nodes,
      initializer: inits,
      input: [valueInfo('input', ['batch', WINDOW, EMB])],
      output: [valueInfo('output', ['batch', 1])],
    },
  });
  if (layers[0].inDim !== FEATURE_DIM) throw new Error('the first layer does not match the feature size');
  fs.writeFileSync(file, onnx.ModelProto.encode(model).finish());
}
