/* Shared Tailwind utility strings for buttons + keyboard chips.
 *
 * A single source for the classes that were copy-pasted across at least
 * six component files. Keeps hover/active states consistent and stops
 * one of the copies from drifting after a redesign. */

export const BTN = "btn appearance-none bg-paper-deep border border-rule text-ink px-3.5 py-1.5 rounded-sm font-sans text-[12.5px] font-semibold tracking-[.04em] transition-colors duration-150 hover:bg-paper-edge hover:border-ink-faint active:translate-y-px";

export const BTN_PRIMARY = "btn btn-primary appearance-none bg-ink border border-ink text-paper px-3.5 py-1.5 rounded-sm font-sans text-[12.5px] font-semibold tracking-[.04em] transition-colors duration-150 hover:bg-accent hover:border-accent active:translate-y-px";

export const KBD = "kbd inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 font-mono text-[11.5px] text-ink bg-paper-deep border border-rule rounded shadow-[0_1px_0_var(--color-paper-edge)]";
