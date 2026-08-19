const primitiveTag = <Value extends object>(value: Value): string => Object.prototype.toString.call(value)

export const isBoolean = <Value>(value: Value): value is Value & boolean => value === true || value === false

export const isFunction = <Value>(
  value: Value
): value is Extract<Value, (...arguments_: Array<never>) => void> => primitiveTag(Object(value)) === "[object Function]"

export const isNumber = <Value>(value: Value): value is Value & number =>
  primitiveTag(Object(value)) === "[object Number]" && Object.is(Object(value).valueOf(), value)

export const isObjectOrArray = <Value>(value: Value): value is Value & object =>
  value !== null && Object(value) === value && !isFunction(value)

export const isString = <Value>(value: Value): value is Value & string =>
  primitiveTag(Object(value)) === "[object String]" && Object(value).valueOf() === value

export const isUndefined = <Value>(value: Value): value is Value & undefined => value === undefined
