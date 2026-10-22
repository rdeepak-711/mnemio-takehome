// Escapes regex special characters so text can be embedded in a RegExp and matched literally.
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
