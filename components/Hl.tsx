export function Hl({ color }: { color: string | null | undefined }) {
  if (!color) return null;
  return <span className={`hl hl-${color}`} aria-label={`${color} highlight`} title={`${color} highlight`} />;
}
