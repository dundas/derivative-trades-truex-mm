/**
 * @file container-info-service.js
 * @description Service for retrieving container information such as hostname and ID.
 * This is useful for logging, metrics, and distributed tracing.
 * 
 * @property {string} hostname - The hostname of the container.
 * @property {string} containerId - A unique ID for the container instance.
 * @property {string} region - The region where the container is running.
 */

import os_module from 'node:os';
import crypto_module from 'node:crypto';

let os = os_module;
// try {
//   os = await import('node:os');
// } catch (e) {
//   console.warn('Failed to import node:os module. Some container info may be unavailable.', e.message);
//   os = null; // Fallback if module is not available
// }

let crypto = crypto_module;
// try {
//   crypto = await import('node:crypto');
// } catch (e) {
//   console.warn('Failed to import node:crypto module. Some container info may be unavailable.', e.message);
//   crypto = null; // Fallback
// }

/**
 * @class ContainerInfoService
 * @description Provides methods to retrieve container-specific information.
 */
class ContainerInfoService {
  constructor() {
    this.hostname = this.getContainerHostname();
    this.containerId = this.getContainerId();
    this.region = process.env.AWS_REGION || process.env.REGION || 'unknown'; 
  }

  /**
   * Get the hostname of the container.
   * @returns {string} The hostname or 'unknown' if not available.
   */
  getContainerHostname() {
    if (os && typeof os.hostname === 'function') {
      try {
        return os.hostname();
      } catch (error) {
        console.warn('Error getting hostname from os module:', error.message);
        return 'unknown-hostname-error';
      }
    } else if (process.env.HOSTNAME) {
      return process.env.HOSTNAME;
    } else if (process.env.COMPUTERNAME) { // Windows environment variable
      return process.env.COMPUTERNAME;
    }
    return 'unknown-hostname';
  }

  /**
   * Get a unique ID for the container instance.
   * Uses randomUUID if available, otherwise generates a simpler pseudo-random ID.
   * @returns {string} A unique ID for the container.
   */
  getContainerId() {
    if (crypto && typeof crypto.randomUUID === 'function') {
      try {
        return crypto.randomUUID();
      } catch (error) {
        console.warn('Error generating UUID with crypto.randomUUID:', error.message);
        // Fall through to simpler ID generation
      }
    }
    // Fallback if crypto.randomUUID is not available or fails
    return `container-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Get all container information.
   * @returns {object} An object containing hostname, containerId, and region.
   */
  getInfo() {
    return {
      hostname: this.hostname,
      containerId: this.containerId,
      region: this.region,
    };
  }
}

// Export a singleton instance
export const containerInfoService = new ContainerInfoService();
