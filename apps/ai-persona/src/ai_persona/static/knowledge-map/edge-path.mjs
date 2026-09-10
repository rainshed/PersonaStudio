// Smooth the routed edges without moving their ports or cutting through cards.
export function edgePath(edge, nodes = []) {
  const points = edge.points;
  if (!points.length) return '';
  const clear = controls => {
    const left = Math.min(...controls.map(p => p.x)), right = Math.max(...controls.map(p => p.x));
    const top = Math.min(...controls.map(p => p.y)), bottom = Math.max(...controls.map(p => p.y));
    // Bézier curves stay inside the bounds of their control points.
    return !nodes.some(n => left < n.x + n.width - .001 && right > n.x + .001 &&
      top < n.y + n.height - .001 && bottom > n.y + .001);
  };
  const applied = edge.type === 'applied_in';
  if (applied && points.length === 4) {
    const [a, b, c, d] = points;
    const horizontal = a.y === b.y && b.x === c.x && c.y === d.y && (b.x - a.x) * (d.x - c.x) > 0;
    const vertical = a.x === b.x && b.y === c.y && c.x === d.x && (b.y - a.y) * (d.y - c.y) > 0;
    if ((horizontal || vertical) && clear(points)) {
      return `M${a.x},${a.y} C${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`;
    }
  }
  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    let radius = Math.min(applied ? 32 : 7, Math.hypot(b.x - a.x, b.y - a.y) / 2,
      Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const corner = r => [
      {x: b.x + Math.sign(a.x - b.x) * r, y: b.y + Math.sign(a.y - b.y) * r},
      b,
      {x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r},
    ];
    // Keep tight bends in narrow passages; use wider arcs where space permits.
    while (radius > .5 && !clear(corner(radius))) radius /= 2;
    if (radius <= .5) path += `L${b.x},${b.y}`;
    else {
      const [p, , q] = corner(radius);
      path += `L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
    }
  }
  const end = points.at(-1);
  return path + `L${end.x},${end.y}`;
}
