// Every agent run records the tool calls it makes, so the site can show its work live.
export function createTrace({ now = () => Date.now(), onChange = () => {} } = {}) {
  const steps = [];
  let last = now();
  const trace = {
    steps,
    current: null,
    // Call before a slow tool so the live log can say what the agent is doing right now.
    begin(label) {
      trace.current = label;
      onChange(trace);
    },
    step(tool, input, summary, status = 'ok') {
      const t = now();
      steps.push({ n: steps.length + 1, tool, input, summary, status, ms: t - last });
      last = t;
      trace.current = null;
      onChange(trace);
    },
  };
  return trace;
}
