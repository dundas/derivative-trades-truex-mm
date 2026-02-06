/**
 * Unit tests for Logger utility
 */
import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { Logger, LogLevel } from './logger.js';

describe('Logger', () => {
  let originalConsole;
  
  // Mock console methods before each test
  beforeEach(() => {
    // Save original console
    originalConsole = {
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error
    };
    
    // Replace with mocks
    console.debug = jest.fn();
    console.info = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  });
  
  // Restore console after each test
  afterEach(() => {
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });
  
  test('should create a logger with default settings', () => {
    const logger = new Logger('TestComponent');
    
    expect(logger.component).toBe('TestComponent');
    expect(logger.minLevel).toBe(LogLevel.INFO);
    expect(logger.useJson).toBe(false);
    expect(logger.includeTimestamp).toBe(true);
  });
  
  test('should respect minimum log level', () => {
    const logger = new Logger('TestComponent', LogLevel.WARN);
    
    // These should be filtered out
    logger.debug('Debug message');
    logger.info('Info message');
    
    // These should pass through
    logger.warn('Warning message');
    logger.error('Error message');
    
    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
  
  test('should format logs correctly in text mode', () => {
    const logger = new Logger('TestComponent');
    logger.includeTimestamp = false; // Disable timestamp for consistent testing
    
    logger.info('Test message');
    
    expect(console.info).toHaveBeenCalledWith(
      '[INFO] [TestComponent] Test message',
      ''
    );
    
    logger.error('Error occurred', { code: 500 });
    
    expect(console.error).toHaveBeenCalledWith(
      '[ERROR] [TestComponent] Error occurred',
      { code: 500 }
    );
  });
  
  test('should format logs correctly in JSON mode', () => {
    const logger = new Logger('TestComponent', LogLevel.INFO, { useJson: true });
    logger.includeTimestamp = false; // Disable timestamp for consistent testing
    
    logger.info('Test message');
    
    expect(console.info).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'INFO',
        component: 'TestComponent',
        message: 'Test message'
      })
    );
    
    logger.error('Error occurred', { code: 500 });
    
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'ERROR',
        component: 'TestComponent',
        message: 'Error occurred',
        data: { code: 500 }
      })
    );
  });
  
  test('should create child loggers that inherit settings', () => {
    const parent = new Logger('Parent', LogLevel.WARN, { useJson: true });
    const child = parent.createChild('Child');
    
    expect(child.component).toBe('Parent:Child');
    expect(child.minLevel).toBe(LogLevel.WARN);
    expect(child.useJson).toBe(true);
    
    // Child should respect inherited log level
    child.info('This should not be logged');
    expect(console.info).not.toHaveBeenCalled();
    
    child.error('This should be logged');
    expect(console.error).toHaveBeenCalled();
  });
  
  test('should allow changing log level dynamically', () => {
    const logger = new Logger('TestComponent', LogLevel.ERROR);
    
    // Warn should be filtered out initially
    logger.warn('Warning 1');
    expect(console.warn).not.toHaveBeenCalled();
    
    // Change level and try again
    logger.setLevel(LogLevel.WARN);
    logger.warn('Warning 2');
    expect(console.warn).toHaveBeenCalled();
  });
  
  test('should allow changing output format dynamically', () => {
    const logger = new Logger('TestComponent');
    logger.includeTimestamp = false; // Disable timestamp for consistent testing
    
    // Default text mode
    logger.info('Message 1');
    expect(console.info).toHaveBeenCalledWith('[INFO] [TestComponent] Message 1', '');
    
    // Change to JSON mode
    logger.setJsonOutput(true);
    logger.info('Message 2');
    expect(console.info).toHaveBeenCalledWith(
      JSON.stringify({
        level: 'INFO',
        component: 'TestComponent',
        message: 'Message 2'
      })
    );
  });
  
  test('LogLevel enum should provide name lookup', () => {
    expect(LogLevel.nameFor(LogLevel.DEBUG)).toBe('DEBUG');
    expect(LogLevel.nameFor(LogLevel.INFO)).toBe('INFO');
    expect(LogLevel.nameFor(LogLevel.WARN)).toBe('WARN');
    expect(LogLevel.nameFor(LogLevel.ERROR)).toBe('ERROR');
    expect(LogLevel.nameFor(99)).toBe('UNKNOWN');
  });
});