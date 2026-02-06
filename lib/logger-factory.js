/**
 * Simple Logger Factory
 * Creates console-based loggers with component name prefix.
 */

export function createLogger(component) {
  const prefix = `[${component}]`;
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    debug: (...args) => console.debug(prefix, ...args),
    createChild: (childName) => createLogger(`${component}:${childName}`),
  };
}

export class LoggerFactory {
  static createLogger(component) {
    return createLogger(component);
  }
}
