/** A line-level Boolean condition whose terms are ripgrep patterns. */
export type SearchCondition =
  | { readonly kind: "term"; readonly value: string; readonly quoted?: boolean }
  | {
      readonly kind: "and" | "or" | "not";
      readonly left: SearchCondition;
      readonly right: SearchCondition;
    };

type TokenType = "term" | "and" | "or" | "not" | "left" | "right" | "end";

interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly offset: number;
  readonly quoted?: boolean;
}

/** Compile the match pattern, paired with compileSearchCondition for Boolean line filtering. */
export function compileSearchQuery(query: string, regex = false): string {
  const tokens = tokenize(query);
  if (!containsBooleanSyntax(tokens)) return regex ? query : escapeRegex(query);

  return matchPattern(compileTerms(new BooleanQueryParser(query, tokens).parse(), regex));
}

/** Compile Boolean line conditions separately from the pattern that selects a match. */
export function compileSearchCondition(query: string, regex = false): SearchCondition | undefined {
  const tokens = tokenize(query);
  return containsBooleanSyntax(tokens)
    ? compileTerms(new BooleanQueryParser(query, tokens).parse(), regex)
    : undefined;
}

/** Evaluate a condition using each term's presence anywhere on the same line. */
export function satisfiesSearchCondition(
  condition: SearchCondition,
  present: (pattern: string) => boolean,
): boolean {
  if (condition.kind === "term") return present(condition.value);
  const left = satisfiesSearchCondition(condition.left, present);
  if (condition.kind === "or") return left || satisfiesSearchCondition(condition.right, present);
  const right = satisfiesSearchCondition(condition.right, present);
  return left && (condition.kind === "not" ? !right : right);
}

function containsBooleanSyntax(tokens: readonly Token[]): boolean {
  return tokens.some(
    (token) =>
      token.quoted === true || token.type === "and" || token.type === "or" || token.type === "not",
  );
}

class BooleanQueryParser {
  readonly #query: string;
  readonly #tokens: readonly Token[];
  #index = 0;

  constructor(query: string, tokens: readonly Token[]) {
    this.#query = query;
    this.#tokens = tokens;
  }

  parse(): SearchCondition {
    const expression = this.#parseOr();
    const token = this.#current();
    if (token.type !== "end") {
      const message =
        token.type === "right" ? "unexpected ')'." : `unexpected ${quoteToken(token)}.`;
      throw syntaxError(token.offset, message);
    }
    return expression;
  }

  #parseOr(): SearchCondition {
    let expression = this.#parseAnd();
    while (this.#current().type === "or") {
      const operator = this.#take();
      const right = this.#parseRequiredPrimary(`after ${operator.value}`);
      expression = { kind: "or", left: expression, right: this.#parseAndTail(right) };
    }
    return expression;
  }

  #parseAnd(): SearchCondition {
    return this.#parseAndTail(this.#parseRequiredPrimary());
  }

  #parseAndTail(initial: SearchCondition): SearchCondition {
    let expression = initial;
    for (;;) {
      const token = this.#current();
      if (token.type === "and" || token.type === "not") {
        this.#take();
        const right = this.#parseRequiredPrimary(`after ${token.value}`);
        expression = { kind: token.type, left: expression, right };
        continue;
      }
      if (token.type === "term" || token.type === "left") {
        expression = { kind: "and", left: expression, right: this.#parseRequiredPrimary() };
        continue;
      }
      return expression;
    }
  }

  #parseRequiredPrimary(context?: string): SearchCondition {
    const token = this.#current();
    if (token.type === "term") {
      this.#take();
      return { kind: "term", value: token.value, quoted: token.quoted };
    }
    if (token.type === "left") {
      this.#take();
      if (this.#current().type === "right" || this.#current().type === "end") {
        throw syntaxError(this.#current().offset, "expected a term after '('.");
      }
      const expression = this.#parseOr();
      if (this.#current().type !== "right") {
        throw syntaxError(this.#current().offset, "expected ')'.");
      }
      this.#take();
      return expression;
    }

    if (
      context === undefined &&
      (token.type === "and" || token.type === "or" || token.type === "not")
    ) {
      throw syntaxError(token.offset, `expected a term before ${token.value}.`);
    }
    const suffix = context === undefined ? "" : ` ${context}`;
    throw syntaxError(token.offset, `expected a term${suffix}.`);
  }

  #current(): Token {
    return (
      this.#tokens[this.#index] ?? {
        type: "end",
        value: "",
        offset: this.#query.length,
      }
    );
  }

  #take(): Token {
    const token = this.#current();
    this.#index += 1;
    return token;
  }
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;

  while (offset < query.length) {
    const character = query.charAt(offset);
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }
    if (character === "(" && isBooleanGroup(query, offset)) {
      tokens.push({ type: "left", value: character, offset });
      offset += 1;
      continue;
    }
    if (character === ")") {
      tokens.push({ type: "right", value: character, offset });
      offset += 1;
      continue;
    }
    if (isBooleanPipe(query, offset)) {
      const width = query.charAt(offset + 1) === "|" ? 2 : 1;
      tokens.push({ type: "or", value: query.slice(offset, offset + width), offset });
      offset += width;
      continue;
    }
    if (character === "'" || character === '"') {
      const start = offset;
      const quote = character;
      let value = "";
      offset += 1;
      while (offset < query.length && query.charAt(offset) !== quote) {
        if (
          query.charAt(offset) === "\\" &&
          (query.charAt(offset + 1) === quote || query.charAt(offset + 1) === "\\")
        ) {
          offset += 1;
        }
        value += query.charAt(offset++);
      }
      if (offset >= query.length) {
        const name = quote === "'" ? "single" : "double";
        throw syntaxError(start, `unterminated ${name}-quoted term.`);
      }
      offset += 1;
      if (value.length === 0) throw syntaxError(start, "quoted terms must not be empty.");
      tokens.push({ type: "term", value, offset: start, quoted: true });
      continue;
    }

    const start = offset;
    while (offset < query.length) {
      const current = query.charAt(offset);
      if (/\s/u.test(current) || current === ")" || isBooleanPipe(query, offset)) break;
      if (current === "\\" && offset + 1 < query.length) {
        offset += 2;
      } else if (current === "[" || current === "(") {
        const end = regexBlockEnd(query, offset);
        offset = end ?? offset + 1;
      } else {
        offset += 1;
      }
    }
    const value = query.slice(start, offset);
    tokens.push({ type: operatorType(value), value, offset: start });
  }

  tokens.push({ type: "end", value: "", offset: query.length });
  return tokens;
}

function isBooleanPipe(query: string, offset: number): boolean {
  return (
    query.charAt(offset) === "|" &&
    (query.charAt(offset + 1) === "|" ||
      (/\s/u.test(query.charAt(offset - 1)) && /\s/u.test(query.charAt(offset + 1))))
  );
}

// Regex blocks own their punctuation, whitespace, and escaped delimiters.
function regexBlockEnd(query: string, start: number): number | undefined {
  const closing = query.charAt(start) === "[" ? "]" : ")";
  let offset = start + 1;
  while (offset < query.length) {
    const character = query.charAt(offset);
    if (character === "\\") {
      offset += 2;
    } else if (character === closing) {
      return offset + 1;
    } else if (closing === ")" && (character === "(" || character === "[")) {
      const end = regexBlockEnd(query, offset);
      if (end === undefined) return undefined;
      offset = end;
    } else {
      offset += 1;
    }
  }
  return undefined;
}

function isBooleanGroup(query: string, offset: number): boolean {
  const end = regexBlockEnd(query, offset);
  if (end === undefined) return true;
  const inner = query.slice(offset + 1, end - 1);
  if (inner.trim().length === 0) return true;
  return containsBooleanSyntax(tokenize(inner));
}

function operatorType(value: string): TokenType {
  if (value === "AND") return "and";
  if (value === "OR") return "or";
  if (value === "NOT") return "not";
  return "term";
}

function quoteToken(token: Token): string {
  return token.value.length > 0 ? JSON.stringify(token.value) : "the end of the query";
}

function syntaxError(offset: number, message: string): SyntaxError {
  return new SyntaxError(
    `Invalid Boolean search query at column ${String(offset + 1)}: ${message}`,
  );
}

function compileTerms(expression: SearchCondition, regex: boolean): SearchCondition {
  if (expression.kind === "term") {
    return {
      kind: "term",
      value: regex && !expression.quoted ? expression.value : escapeRegex(expression.value),
    };
  }
  return {
    kind: expression.kind,
    left: compileTerms(expression.left, regex),
    right: compileTerms(expression.right, regex),
  };
}

function matchPattern(condition: SearchCondition): string {
  if (condition.kind === "term") return condition.value;
  const left = matchPattern(condition.left);
  return condition.kind === "not" ? left : `(?:${left}|${matchPattern(condition.right)})`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
