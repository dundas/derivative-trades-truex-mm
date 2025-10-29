/**
 * Deep Comparison Utility
 * 
 * Provides utilities for deeply comparing JavaScript objects
 * and formatting the differences in a human-readable way.
 */

/**
 * Performs a deep comparison between two objects and identifies all differences
 * @param {any} obj1 - First object to compare
 * @param {any} obj2 - Second object to compare
 * @returns {Object} Result with identical flag and list of differences
 */
export function deepCompare(obj1, obj2) {
  const differences = [];
  compareValues(obj1, obj2, '', differences);
  
  return {
    identical: differences.length === 0,
    differences
  };
}

/**
 * Helper function to recursively compare values
 * @param {any} val1 - First value
 * @param {any} val2 - Second value
 * @param {string} path - Current object path
 * @param {Array} differences - Array to collect differences
 */
function compareValues(val1, val2, path, differences) {
  // Different types
  if (typeof val1 !== typeof val2) {
    differences.push({
      path: path || 'root',
      type: 'type_mismatch',
      value1: `${typeof val1}: ${simpleFormat(val1)}`,
      value2: `${typeof val2}: ${simpleFormat(val2)}`
    });
    return;
  }
  
  // Handle null
  if (val1 === null && val2 === null) {
    return;
  } else if (val1 === null || val2 === null) {
    differences.push({
      path: path || 'root',
      type: 'null_mismatch',
      value1: val1,
      value2: val2
    });
    return;
  }
  
  // Compare arrays
  if (Array.isArray(val1) && Array.isArray(val2)) {
    // Different lengths
    if (val1.length !== val2.length) {
      differences.push({
        path: path || 'root',
        type: 'array_length',
        value1: `Array(${val1.length})`,
        value2: `Array(${val2.length})`
      });
    }
    
    // Compare each element
    const maxLen = Math.max(val1.length, val2.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= val1.length || i >= val2.length) {
        continue; // Already reported length difference
      }
      compareValues(val1[i], val2[i], `${path}[${i}]`, differences);
    }
    return;
  }
  
  // Compare objects (but not arrays, already handled)
  if (typeof val1 === 'object' && typeof val2 === 'object') {
    const keys1 = Object.keys(val1);
    const keys2 = Object.keys(val2);
    
    // Check for missing keys
    const allKeys = new Set([...keys1, ...keys2]);
    
    for (const key of allKeys) {
      const keyPath = path ? `${path}.${key}` : key;
      
      if (!(key in val1)) {
        differences.push({
          path: keyPath,
          type: 'key_missing_in_first',
          value1: undefined,
          value2: simpleFormat(val2[key])
        });
      } else if (!(key in val2)) {
        differences.push({
          path: keyPath,
          type: 'key_missing_in_second',
          value1: simpleFormat(val1[key]),
          value2: undefined
        });
      } else {
        // Key exists in both, compare values
        compareValues(val1[key], val2[key], keyPath, differences);
      }
    }
    return;
  }
  
  // Compare primitive values
  if (val1 !== val2) {
    // Special case for numbers to handle NaN and floating point comparison
    if (typeof val1 === 'number' && typeof val2 === 'number') {
      // Handle NaN
      if (isNaN(val1) && isNaN(val2)) {
        return;
      }
      
      // Handle floating point comparison with small tolerance
      if (Math.abs(val1 - val2) < 0.0000001) {
        return;
      }
    }
    
    differences.push({
      path: path || 'root',
      type: 'value_mismatch',
      value1: val1,
      value2: val2
    });
  }
}

/**
 * Simple formatter for values to ensure they're displayed reasonably in output
 * @param {any} value - Value to format
 * @returns {string} Formatted value
 */
function simpleFormat(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return `Array(${value.length})`;
    }
    return `Object(${Object.keys(value).length} keys)`;
  }
  
  return String(value);
}

/**
 * Format the differences in a human-readable way
 * @param {Array} differences - Array of differences
 * @returns {string} Formatted differences
 */
export function formatDiff(differences) {
  if (!differences.length) return 'No differences found';
  
  return differences.map(diff => {
    const { path, type, value1, value2 } = diff;
    
    switch (type) {
      case 'type_mismatch':
        return `Path: ${path} - Type mismatch: ${value1} vs ${value2}`;
      case 'null_mismatch':
        return `Path: ${path} - Null mismatch: ${value1 === null ? 'null' : 'not null'} vs ${value2 === null ? 'null' : 'not null'}`;
      case 'array_length':
        return `Path: ${path} - Array length mismatch: ${value1} vs ${value2}`;
      case 'key_missing_in_first':
        return `Path: ${path} - Key missing in first object, second has: ${value2}`;
      case 'key_missing_in_second':
        return `Path: ${path} - Key missing in second object, first has: ${value1}`;
      case 'value_mismatch':
        return `Path: ${path} - Value mismatch: ${value1} vs ${value2}`;
      default:
        return `Path: ${path} - Unknown difference type: ${type}`;
    }
  }).join('\n');
}
