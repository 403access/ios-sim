/**
 * Minimal XML property-list parser for launchd-style manifests.
 *
 * Supported: dict, array, key, string, integer, real, true, false, data.
 * Rejected with a stable error: DTDs/entities beyond the five XML escapes,
 * binary plists, CDATA, and excessive nesting. No XML library is pulled in,
 * which keeps the research track dependency-free and the parser auditable.
 */

import { PlistError } from "../errors.js";

export type PlistValue =
  string | number | boolean | Uint8Array | PlistValue[] | { [key: string]: PlistValue };

const MAX_DEPTH = 64;
const MAX_INPUT = 4 * 1024 * 1024;

interface Token {
  readonly kind: "open" | "close" | "empty" | "text";
  readonly name: string;
  readonly text: string;
  readonly offset: number;
}

export function parsePlist(source: string | Uint8Array): PlistValue {
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);
  if (text.length > MAX_INPUT)
    throw new PlistError("plist_too_large", `plist exceeds ${MAX_INPUT} characters`);
  if (text.startsWith("bplist")) {
    throw new PlistError(
      "binary_plist_unsupported",
      "binary plists are not supported by the XML parser",
    );
  }
  if (/<!DOCTYPE[^>]*\[/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new PlistError(
      "plist_dtd",
      "DOCTYPE internal subsets and entities are not allowed in plists",
    );
  }
  if (text.includes("<![CDATA["))
    throw new PlistError("plist_cdata", "CDATA sections are not supported");

  const tokens = tokenize(text);
  let index = 0;
  const next = (): Token => {
    const token = tokens[index++];
    if (!token) throw new PlistError("plist_truncated", "plist ended unexpectedly");
    return token;
  };
  const peek = (): Token | undefined => tokens[index];

  let root: PlistValue | undefined;
  while (index < tokens.length) {
    const token = peek();
    if (!token) break;
    if (token.kind === "text" && token.text.trim() === "") {
      index += 1;
      continue;
    }
    if (token.kind === "open" && token.name === "plist") {
      index += 1;
      if (root !== undefined)
        throw new PlistError("plist_multiple_roots", "plist contains multiple root values");
      root = parseValue(0);
      let close = next();
      while (close.kind === "text" && close.text.trim() === "") close = next();
      if (close.kind !== "close" || close.name !== "plist") {
        throw new PlistError("plist_bad_close", `expected </plist> at offset ${close.offset}`);
      }
      continue;
    }
    if (root !== undefined)
      throw new PlistError("plist_trailing", `unexpected content at offset ${token.offset}`);
    root = parseValue(0);
  }

  if (root === undefined) throw new PlistError("plist_empty", "plist has no root value");
  return root;

  function parseValue(depth: number): PlistValue {
    if (depth > MAX_DEPTH)
      throw new PlistError("plist_too_deep", `plist exceeds depth ${MAX_DEPTH}`);
    let token = next();
    if (token.kind === "text") {
      if (token.text.trim() !== "")
        throw new PlistError("plist_text", `unexpected text at offset ${token.offset}`);
      return parseValue(depth);
    }
    if (token.kind === "empty") {
      if (token.name === "true") return true;
      if (token.name === "false") return false;
      if (token.name === "dict") return {};
      if (token.name === "array") return [];
      if (token.name === "string") return "";
      throw new PlistError("plist_unknown_tag", `unknown plist tag <${token.name}/>`);
    }
    if (token.kind === "close")
      throw new PlistError("plist_unexpected_close", `unexpected </${token.name}>`);

    switch (token.name) {
      case "dict":
        return parseDict(depth);
      case "array":
        return parseArray(depth);
      case "string":
        return readText(token.name);
      case "integer": {
        const raw = readText(token.name).trim();
        if (!/^-?\d+$/.test(raw))
          throw new PlistError("plist_bad_integer", `invalid integer ${raw}`);
        const value = Number(raw);
        if (!Number.isSafeInteger(value))
          throw new PlistError("plist_bad_integer", `integer ${raw} is not safe`);
        return value;
      }
      case "real": {
        const raw = readText(token.name).trim();
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new PlistError("plist_bad_real", `invalid real ${raw}`);
        return value;
      }
      case "data": {
        const raw = readText(token.name).replace(/\s+/g, "");
        try {
          return Uint8Array.from(Buffer.from(raw, "base64"));
        } catch {
          throw new PlistError("plist_bad_data", "invalid base64 data value");
        }
      }
      default:
        throw new PlistError("plist_unknown_tag", `unknown plist tag <${token.name}>`);
    }
  }

  function parseDict(depth: number): { [key: string]: PlistValue } {
    const result: { [key: string]: PlistValue } = {};
    while (true) {
      const token = next();
      if (token.kind === "close" && token.name === "dict") return result;
      if (token.kind === "text" && token.text.trim() === "") continue;
      if (token.kind === "empty" && token.name === "dict") return result;
      if (token.kind !== "open" || token.name !== "key") {
        throw new PlistError("plist_bad_dict", `expected <key> in dict at offset ${token.offset}`);
      }
      const key = readText("key");
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new PlistError("plist_unsafe_key", `dictionary key ${key} is not allowed`);
      }
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw new PlistError("plist_duplicate_key", `duplicate dictionary key ${key}`);
      }
      result[key] = parseValue(depth + 1);
    }
  }

  function parseArray(depth: number): PlistValue[] {
    const result: PlistValue[] = [];
    while (true) {
      const token = next();
      if (token.kind === "close" && token.name === "array") return result;
      if (token.kind === "text" && token.text.trim() === "") continue;
      if (token.kind === "empty" && token.name === "array") return result;
      index -= 1;
      result.push(parseValue(depth + 1));
    }
  }

  function readText(name: string): string {
    let value = "";
    while (true) {
      const token = next();
      if (token.kind === "close" && token.name === name) return decodeEntities(value);
      if (token.kind !== "text")
        throw new PlistError("plist_bad_text", `expected text in <${name}>`);
      value += token.text;
    }
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "<") {
      if (text.startsWith("<!--", index)) {
        const end = text.indexOf("-->", index + 4);
        if (end === -1)
          throw new PlistError("plist_unterminated_comment", "XML comment is not terminated");
        index = end + 3;
        continue;
      }
      if (text.startsWith("<?", index)) {
        const end = text.indexOf("?>", index + 2);
        if (end === -1)
          throw new PlistError(
            "plist_unterminated_pi",
            "XML processing instruction is not terminated",
          );
        index = end + 2;
        continue;
      }
      if (text.startsWith("<!DOCTYPE", index)) {
        const end = text.indexOf(">", index + 9);
        if (end === -1)
          throw new PlistError("plist_unterminated_doctype", "DOCTYPE is not terminated");
        index = end + 1;
        continue;
      }
      const end = text.indexOf(">", index + 1);
      if (end === -1)
        throw new PlistError("plist_unterminated_tag", `tag at offset ${index} is not terminated`);
      let body = text.slice(index + 1, end).trim();
      const empty = body.endsWith("/");
      if (empty) body = body.slice(0, -1).trim();
      const close = body.startsWith("/");
      if (close) body = body.slice(1).trim();
      const nameMatch = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(body);
      if (!nameMatch) throw new PlistError("plist_bad_tag", `malformed tag at offset ${index}`);
      tokens.push({
        kind: close ? "close" : empty ? "empty" : "open",
        name: nameMatch[1]!,
        text: "",
        offset: index,
      });
      index = end + 1;
      continue;
    }
    const nextTag = text.indexOf("<", index);
    const end = nextTag === -1 ? text.length : nextTag;
    tokens.push({ kind: "text", name: "", text: text.slice(index, end), offset: index });
    index = end;
  }
  return tokens;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const codePoint = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : entity.startsWith("#")
            ? Number.parseInt(entity.slice(1), 10)
            : Number.NaN;
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
          throw new PlistError("plist_bad_entity", `invalid XML entity ${match}`);
        }
        return String.fromCodePoint(codePoint);
      }
    }
  });
}
