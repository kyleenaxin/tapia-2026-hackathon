// Every agent run records the tool calls it made so the UI can show its work.
export function createTrace() {
  const steps = [];
  return {
    steps,
    step(tool, input, summary, status = 'ok') {
      steps.push({ n: steps.length + 1, tool, input, summary, status });
    },
  };
}
