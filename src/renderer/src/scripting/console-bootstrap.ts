/**
 * This fixed program executes INSIDE QuickJS. It captures guest intrinsics before
 * user code runs. No object inspection/conversion is performed in the host realm.
 * The only host function is captured in a closure, then removed from guest globals.
 */
export const CONSOLE_BOOTSTRAP = String.raw`
(function (emit) {
  "use strict";
  const ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor;
  const define = Object.defineProperty;
  const freeze = Object.freeze;
  const create = Object.create;
  const isArray = Array.isArray;
  const StringValue = String;
  const NumberValue = Number;
  const ParseInt = parseInt;
  const ParseFloat = parseFloat;
  const stringify = JSON.stringify;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const indexOf = Function.prototype.call.bind(Array.prototype.indexOf);
  const push = Function.prototype.call.bind(Array.prototype.push);
  const pop = Function.prototype.call.bind(Array.prototype.pop);
  const join = Function.prototype.call.bind(Array.prototype.join);
  const MAX = 4096;
  const short = value => value.length > MAX ? slice(value, 0, MAX - 14) + "… [truncated]" : value;
  function inspect(value, quote, seen, depth, budget) {
    if (--budget.left < 0) return "[Inspection limit]";
    if (value === null) return "null";
    const type = typeof value;
    if (type === "string") return quote ? short(stringify(short(value))) : short(value);
    if (type === "undefined") return "undefined";
    if (type === "bigint") return short(StringValue(value)) + "n";
    if (type === "number" || type === "boolean" || type === "symbol") return short(StringValue(value));
    if (type === "function") return "[Function]";
    if (indexOf(seen, value) >= 0) return "[Circular]";
    if (depth >= 4) return "[Object]";
    push(seen, value);
    try {
      const array = isArray(value);
      const keys = ownKeys(value);
      const parts = [];
      let length = 0;
      for (let i = 0; i < keys.length && i < 30; i++) {
        const key = keys[i];
        if (array && key === "length") continue;
        const entry = descriptor(value, key);
        if (!entry || !entry.enumerable) continue;
        const rendered = hasOwn(entry, "value") ? inspect(entry.value, true, seen, depth + 1, budget) : "[Getter/Setter]";
        const part = array ? rendered : short(StringValue(key)) + ": " + rendered;
        push(parts, part);
        length += part.length;
        if (length >= MAX || budget.left <= 0) { push(parts, "…"); break; }
      }
      if (keys.length > 30) push(parts, "…");
      return short((array ? "[ " : "{ ") + join(parts, ", ") + (array ? " ]" : " }"));
    } catch (_) {
      return "[Uninspectable]";
    } finally { pop(seen); }
  }
  function render(value, quote = false) {
    // Error.stack is an own data property in QuickJS; never read a guest getter.
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      try {
        const message = descriptor(value, "message");
        const stack = descriptor(value, "stack");
        if (message && hasOwn(message, "value") && typeof message.value === "string" &&
            stack && hasOwn(stack, "value") && typeof stack.value === "string") {
          return short(message.value + "\n" + stack.value);
        }
      } catch (_) { return "[Uninspectable]"; }
    }
    return inspect(value, quote, [], 0, { left: 150 });
  }
  // A safe JSON subset: inspect own data descriptors, never call getters or
  // toJSON. BigInt is quoted with an n suffix; cycles/accessors/limits use
  // quoted placeholders. Omitted values follow JSON's object/array conventions.
  function json(value, seen, depth, budget) {
    const limit = '"[Inspection limit]"';
    if (--budget.left < 0) return limit;
    if (value === null) return "null";
    const type = typeof value;
    if (type === "undefined" || type === "function" || type === "symbol") return undefined;
    if (type === "string" || type === "bigint") {
      const encoded = stringify(short(type === "bigint" ? StringValue(value) + "n" : value));
      return encoded.length > MAX ? limit : encoded;
    }
    if (type === "number" || type === "boolean") return stringify(value);
    if (indexOf(seen, value) >= 0) return '"[Circular]"';
    if (depth >= 4) return limit;
    push(seen, value);
    try {
      const array = isArray(value);
      const parts = [];
      let length = 2;
      const keys = array ? undefined : ownKeys(value);
      const arrayLength = array ? descriptor(value, "length") : undefined;
      const count = array
        ? (arrayLength && hasOwn(arrayLength, "value") && typeof arrayLength.value === "number" ? arrayLength.value : 0)
        : keys.length;
      for (let i = 0; i < count && i < 30; i++) {
        const key = array ? StringValue(i) : keys[i];
        if (typeof key !== "string") continue;
        const entry = descriptor(value, key);
        if (!array && (!entry || !entry.enumerable)) continue;
        const rendered = entry
          ? (hasOwn(entry, "value") ? json(entry.value, seen, depth + 1, budget) : '"[Getter/Setter]"')
          : undefined;
        if (!array && rendered === undefined) continue;
        const part = array ? (rendered === undefined ? "null" : rendered) : stringify(short(key)) + ":" + rendered;
        length += part.length + 1;
        if (length > MAX || budget.left <= 0) return limit;
        push(parts, part);
      }
      if (count > 30) return limit;
      return (array ? "[" : "{") + join(parts, ",") + (array ? "]" : "}");
    } catch (_) {
      return '"[Uninspectable]"';
    } finally { pop(seen); }
  }
  function numeric(value, token) {
    const type = typeof value;
    if ((type === "object" && value !== null) || type === "function" || type === "symbol") return "NaN";
    if (type === "bigint" && token !== "f") return short(StringValue(value)) + "n";
    const number = token === "i" ? ParseInt(value, 10) : token === "f" ? ParseFloat(value) : NumberValue(value);
    return token === "d" && number === 0 && 1 / number < 0 ? "-0" : StringValue(number);
  }
  function format(args) {
    let result = "";
    let next = 0;
    if (typeof args[0] === "string") {
      const template = short(args[0]);
      next = 1;
      for (let i = 0; i < template.length && result.length < MAX; i++) {
        if (template[i] === "%" && i + 1 < template.length) {
          const token = template[i + 1];
          if (token === "%") { result += "%"; i++; continue; }
          if (next < args.length && (token === "s" || token === "d" || token === "i" ||
              token === "f" || token === "o" || token === "O" || token === "j")) {
            const arg = args[next++];
            if (token === "d" || token === "i" || token === "f") {
              result += numeric(arg, token);
            } else if (token === "j") {
              const encoded = json(arg, [], 0, { left: 150 });
              result += encoded === undefined ? "undefined" : encoded;
            } else { result += render(arg); }
            i++;
            continue;
          }
        }
        result += template[i];
      }
    }
    for (; next < args.length && next < 100 && result.length < MAX; next++) {
      if (next > 0) result += " ";
      result += render(args[next]);
    }
    return short(result);
  }
  const consoleObject = create(null);
  for (const level of ["log", "info", "debug", "warn", "error"]) {
    define(consoleObject, level, { value: freeze((...args) => emit(level, format(args))), enumerable: true });
  }
  define(globalThis, "console", { value: freeze(consoleObject), enumerable: true });
  return freeze(render);
})
`;
