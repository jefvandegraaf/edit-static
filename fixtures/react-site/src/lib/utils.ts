export function cn(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}
