import { describe, it, expect } from 'vitest';
import { parseFlowchart } from './flowchart';
import { layoutFlowchart } from './layout';

describe('bidirectional flowcharts', () => {
  it.each(['<-->', '<==>', '<-.->'])('keeps labels and both endpoints for %s', token => {
    const chart = parseFlowchart(`flowchart TD\n C[Клиент] ${token}|WebSocket| D[Paseo Daemon: Node.js]\n S[Supervisor] --> D\n D ${token} X[Процессы Codex]\n X --> M[Провайдер модели]`)!;
    expect(chart.skipped).toEqual([]);
    expect(chart.nodes.map(n => n.label)).toEqual(['Клиент', 'Paseo Daemon: Node.js', 'Supervisor', 'Процессы Codex', 'Провайдер модели']);
    expect(chart.edges).toHaveLength(4);
    expect(chart.edges[0]).toMatchObject({from:'C', to:'D', label:'WebSocket', arrow:true, arrowStart:true});
    const layout = layoutFlowchart(chart);
    expect(layout.edges[0].arrowAt).not.toBeNull();
    expect(layout.edges[0].arrowStartAt).not.toBeNull();
    expect(layout.edges[1].arrowStartAt).toBeNull();
  });
  it.each(['TD', 'BT', 'LR', 'RL'])('routes both endpoints for %s, including a lane', direction => {
    const chart = parseFlowchart(`flowchart ${direction}\n A[Client] <--> B[Daemon]\n B --> C[Model]\n A <--> C`)!;
    const layout = layoutFlowchart(chart);
    expect(layout.edges.filter(e => e.arrowStart)).toHaveLength(2);
    for (const edge of layout.edges.filter(e => e.arrowStart)) {
      expect(edge.arrowStartAt).not.toBeNull();
      expect(edge.arrowAt).not.toBeNull();
      expect(edge.arrowStartAt).not.toEqual(edge.arrowAt);
    }
  });
});
