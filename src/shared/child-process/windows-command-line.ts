/**
 * Windows command-line construction.
 *
 * Two parsers read the line Orca hands to CreateProcess, and they disagree:
 *
 * - The target program's own startup code (`CommandLineToArgvW`, which the CRT and
 *   Node both use) understands `\"` as a literal quote and `\\` as a literal
 *   backslash.
 * - `cmd.exe` — unavoidable for a `.cmd`/`.bat` target — does NOT. It counts `"`
 *   naively to track quote state, and inside that state it still expands `%VAR%`.
 *
 * So a `\"` written for the first parser silently flips cmd's quote parity, and
 * every later `&` `|` `<` `>` on the line stops being data and becomes an
 * operator. Measured on Windows 11 with a real `.cmd` shim: `["a b", 'c"d',
 * "e%F%g", "h&i", "j^k"]` came back as `["a b", 'c"d', "e^%F^%g", "h"]` — the
 * `&` truncated the argument AND ran the remainder as a command.
 *
 * The encoding below satisfies both parsers at once and round-trips all of the
 * adversarial cases; see windows-command-line.test.ts for the corpus.
 */

/**
 * Quote one argument for `CommandLineToArgvW`, writing an embedded `"` as `""`
 * rather than `\"`.
 *
 * Why `""` and not `\"`: both spellings decode to a literal quote, but only `""`
 * leaves cmd's naive quote count even. Since the same encoding has to survive a
 * cmd hop for `.cmd` targets, we pay the (identical-length) `""` spelling
 * everywhere rather than keep two dialects.
 *
 * Backslashes are still doubled before a quote and at the end of a quoted run,
 * because that part `CommandLineToArgvW` does interpret.
 */
export function quoteWindowsArgument(value: string): string {
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      // The backslash run is literal, so double it; the quote itself becomes `""`.
      quoted += `${'\\'.repeat(backslashes * 2)}""`
      backslashes = 0
      continue
    }
    quoted += `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  // Trailing backslashes precede the closing quote, so they need doubling too —
  // otherwise `C:\dir\` ends the argument with an escaped quote and swallows it.
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/**
 * Neutralise `%` for the cmd hop.
 *
 * `%VAR%` expands even inside a quoted token, so an argument mentioning a real
 * environment variable arrives as its value (`x%ORCATEST%y` -> `xBOOMy`). `^%`
 * escapes it, but only outside quotes — hence closing the quote around each `%`
 * and reopening after. The two added quotes keep cmd's parity even, so the
 * surrounding argument stays quoted from cmd's point of view, and adjacent
 * quoted runs concatenate into one argv element.
 */
function escapePercentForCmd(quoted: string): string {
  return quoted.replaceAll('%', '"^%"')
}

/**
 * Build the argv Node should spawn to run `program` with `args` through
 * `cmd.exe`, for targets cmd must interpret (`.cmd`, `.bat`).
 *
 * Callers must pass the result with `windowsVerbatimArguments: true` so Node
 * hands the line through untouched, and must NOT set `shell: true` — that
 * concatenates arguments without escaping (Node warns DEP0190) and silently
 * disables `windowsHide`.
 *
 * `/d` skips AutoRun commands from the registry, which would otherwise run
 * arbitrary user configuration before our command. `/v:off` pins delayed
 * expansion off so a `!` in an argument stays literal even where the Command
 * Processor registry default turns it on. `/s` makes cmd strip exactly the
 * outer quote pair and treat the rest verbatim.
 */
export function buildWindowsCmdShimCommandLine(program: string, args: readonly string[]): string {
  // Why reject rather than encode: cmd's line parser ends the command at a raw
  // CR or LF whatever the quote state, so there is no escape for it -- quoting
  // does not survive a line break. Encoding one anyway truncates the argument
  // and can leave the remainder to be interpreted as a further command. Agent
  // prompts are the motivating input here and can contain newlines, so this
  // has to fail loudly rather than silently mangle.
  for (const value of [program, ...args]) {
    if (/[\r\n]/.test(value)) {
      throw new Error('cmd.exe cannot receive an argument containing a line break')
    }
  }
  const inner = [
    quoteWindowsArgument(program),
    ...args.map((arg) => escapePercentForCmd(quoteWindowsArgument(arg)))
  ].join(' ')
  return `/d /v:off /s /c "${inner}"`
}

const CMD_INTERPRETED_EXTENSIONS = ['.cmd', '.bat']

/** Whether `program` is a target Windows can only start through `cmd.exe`. */
export function isCmdInterpretedProgram(program: string): boolean {
  const lower = program.toLowerCase()
  return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
