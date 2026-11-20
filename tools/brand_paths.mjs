/** Relative coordinates keep the same curves while compressing neighboring points together. */
export function compactPath(path) {
  const commands = [...path.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)];
  if (commands.some(([, command]) => !['M', 'L', 'C', 'Z'].includes(command))) return path;
  const precision = Math.max(0, ...[...path.matchAll(/\.(\d+)/g)].map((match) => match[1].length));
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  return commands.map(([, command, points]) => {
    if (command === 'Z') {
      x = startX;
      y = startY;
      return 'z';
    }
    const numbers = points.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
    const length = command === 'C' ? 6 : 2;
    // Explicit segments keep each curve's starting point unambiguous.
    if (numbers.length !== length) throw new Error('Unexpected brand path coordinates');
    const relative = numbers.map((value, index) =>
      Number((value - (index % 2 === 0 ? x : y)).toFixed(precision)),
    );
    x = numbers.at(-2);
    y = numbers.at(-1);
    if (command === 'M') {
      startX = x;
      startY = y;
    }
    return command.toLowerCase() + relative.join(' ');
  }).join('');
}
