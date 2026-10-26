import { describe, expect, it } from "vitest";
import {
  FoundationError,
  NSArray,
  NSDictionary,
  NSMutableArray,
  NSMutableDictionary,
  NSMutableString,
  NSString,
} from "./collections.js";

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

describe("Foundation container conformance", () => {
  it("matches JS strings across 100 generated operations", () => {
    const random = prng(0x51aa);
    const string = new NSMutableString("seed");
    let expected = "seed";
    for (let index = 0; index < 100; index += 1) {
      const operation = Math.floor(random() * 3);
      if (operation === 0) {
        const value = String.fromCharCode(97 + Math.floor(random() * 26));
        string.append(value);
        expected += value;
      } else if (operation === 1) {
        const from = Math.floor(random() * (expected.length + 1));
        const to = from + Math.floor(random() * (expected.length - from + 1));
        expect(string.substring(from, to).toString()).toBe(expected.slice(from, to));
      } else {
        const at = Math.floor(random() * expected.length);
        expect(string.characterAt(at)).toBe(expected[at]);
      }
      expect(string.length()).toBe(expected.length);
      expect(string.toString()).toBe(expected);
    }
  });

  it("matches JS arrays across 100 generated operations", () => {
    const random = prng(0xa77a);
    const array = new NSMutableArray<number>();
    const expected: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const operation = Math.floor(random() * 3);
      if (operation === 0) {
        const value = Math.floor(random() * 1000);
        array.add(value);
        expected.push(value);
      } else if (operation === 1 && expected.length > 0) {
        const at = Math.floor(random() * expected.length);
        expect(array.removeAt(at)).toBe(expected.splice(at, 1)[0]);
      } else {
        const at = Math.floor(random() * (expected.length + 1));
        const value = Math.floor(random() * 1000);
        array.insert(value, at);
        expected.splice(at, 0, value);
      }
      expect(array.count()).toBe(expected.length);
      expect(array.toArray()).toEqual(expected);
    }
  });

  it("matches JS maps across 100 generated operations", () => {
    const random = prng(0xd1c7);
    const dictionary = new NSMutableDictionary<number>();
    const expected = new Map<string, number>();
    for (let index = 0; index < 100; index += 1) {
      const key = `k${Math.floor(random() * 20)}`;
      if (random() < 0.7) {
        const value = Math.floor(random() * 1000);
        dictionary.setObject(key, value);
        expected.set(key, value);
      } else {
        expect(dictionary.removeObject(key)).toBe(expected.delete(key));
      }
      expect(dictionary.count()).toBe(expected.size);
      expect(dictionary.objectForKey(key)).toBe(expected.get(key));
    }
  });

  it("reports stable bounds and key errors", () => {
    const string = NSString.from("abc");
    const array = NSArray.from([1, 2, 3]);
    const dictionary = new NSDictionary({ a: 1 });
    expect(() => string.characterAt(3)).toThrow(FoundationError);
    expect(() => string.substring(2, 1)).toThrow(/invalid/);
    expect(() => array.objectAt(-1)).toThrow(/outside/);
    expect(() => new NSMutableArray<number>().removeAt(0)).toThrow(/outside/);
    expect(() => new NSMutableDictionary<number>().setObject("", 1)).toThrow(/empty/);
    expect(dictionary.objectForKey("missing")).toBeUndefined();
  });
});
