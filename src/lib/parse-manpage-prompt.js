/* Prompt body parser. Pulls structured sections from self-eliciting bodies:
 *   ROLE: ... (paragraph until blank line)
 *   <intro paragraph>
 *   You need: 1. ... 2. ...     (numbered inputs)
 *   Then execute: - ... - ...   (bulleted steps)
 *   Halt at: ...
 *   Conventions: - ... - ...    (bulleted)
 * Returns { role, intro, inputs[], execution[], halt, conventions[] }.
 * For multi-step prompts, call once per step.body. */

export function parsePromptManpage(body) {
  const out = { role: "", intro: "", inputs: [], execution: [], halt: "", conventions: [] };
  if (!body) return out;
  const lines = body.split("\n");

  // ROLE: span until blank line
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("ROLE:")) {
      let role = lines[i].slice(5).trim();
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== "") {
        role += " " + lines[j].trim();
        j++;
      }
      out.role = role;
      break;
    }
  }

  // Intro: first non-ROLE paragraph before "Before you start"
  const introMatch = body.match(/^(?:ROLE:[^\n]*(?:\n[^\n]+)*\n\n)?([^\n][^]+?)(?=\n\nBefore you start)/);
  if (introMatch) {
    const cand = introMatch[1].trim();
    if (!/^ROLE:/.test(cand)) out.intro = cand.replace(/\n+/g, " ");
  }

  // Inputs
  const inputsBlock = matchBlock(body, /You need:\s*\n/, /\n\n(?=When you have all answers|Then execute)/);
  if (inputsBlock) out.inputs = extractNumbered(inputsBlock);

  // Execution
  const execBlock = matchBlock(body, /Then execute[^\n]*:\s*\n/, /\n\nHalt at|\n\nConventions/);
  if (execBlock) out.execution = extractBulleted(execBlock);

  // Halt
  const haltMatch = body.match(/Halt at:\s*([^\n]+(?:\n(?!Conventions:)[^\n]+)*)/);
  if (haltMatch) out.halt = haltMatch[1].replace(/\n+/g, " ").trim();

  // Conventions
  const convBlock = matchBlock(body, /Conventions:\s*\n/, /\n*$/);
  if (convBlock) out.conventions = extractBulleted(convBlock);

  return out;
}

export function matchBlock(text, startRe, endRe) {
  const start = text.search(startRe);
  if (start < 0) return null;
  const after = text.slice(start).match(startRe);
  const sliceStart = start + after[0].length;
  const rest = text.slice(sliceStart);
  const endMatch = rest.search(endRe);
  return endMatch < 0 ? rest : rest.slice(0, endMatch);
}

export function extractNumbered(block) {
  const items = [];
  let current = "";
  block.split("\n").forEach(line => {
    if (/^\s*\d+\.\s/.test(line)) {
      if (current) items.push(current.trim());
      current = line.replace(/^\s*\d+\.\s/, "").trim();
    } else if (line.trim() === "") {
      // skip
    } else {
      current += " " + line.trim();
    }
  });
  if (current) items.push(current.trim());
  return items;
}

export function extractBulleted(block) {
  const items = [];
  let current = "";
  block.split("\n").forEach(line => {
    if (/^\s*[-*]\s/.test(line)) {
      if (current) items.push(current.trim());
      current = line.replace(/^\s*[-*]\s/, "").trim();
    } else if (line.trim() === "") {
      if (current) { items.push(current.trim()); current = ""; }
    } else if (current) {
      current += " " + line.trim();
    }
  });
  if (current) items.push(current.trim());
  return items;
}
