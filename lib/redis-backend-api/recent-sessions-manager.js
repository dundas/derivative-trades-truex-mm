/**
 * Recent Sessions Manager
 * 
 * Efficiently tracks recent trading sessions using Redis sorted sets.
 * Maintains sessions for the most recent 72 hours for fast active session checking.
 * 
 * Uses Redis ZSET with timestamps as scores for efficient time-based operations.
 * 
 * Philosophy: Keep ALL sessions (active, completed, failed) for 72 hours to provide
 * historical context, debugging capabilities, and analytics. Only remove sessions
 * when they age out beyond the 72-hour window.
 */

export class RecentSessionsManager {
    constructor({ redis, logger, keyPrefix = 'recent_sessions' }) {
        this.redis = redis;
        this.logger = logger;
        this.keyPrefix = keyPrefix;
        this.recentSessionsKey = `${keyPrefix}:active`;
        this.RETENTION_HOURS = 72; // Keep sessions for 72 hours
        this.RETENTION_MS = this.RETENTION_HOURS * 60 * 60 * 1000;
    }

    /**
     * Add a session to the recent sessions tracker
     * @param {string} sessionId - Session ID
     * @param {number} startTimestamp - Session start timestamp
     * @param {Object} sessionMetadata - Additional session metadata
     */
    async addSession(sessionId, startTimestamp = Date.now(), sessionMetadata = {}) {
        try {
            // Always remove any existing entries for this sessionId first to prevent duplicates
            await this.removeSession(sessionId);
            
            // Now add the new session entry
            const score = startTimestamp;
            const sessionData = {
                sessionId,
                startTimestamp,
                addedAt: Date.now(),
                ...sessionMetadata
            };

            // Add to sorted set with timestamp as score
            await this.redis.zadd(this.recentSessionsKey, score, JSON.stringify(sessionData));
            
            // Set expiration on the key to prevent it from growing indefinitely
            await this.redis.expire(this.recentSessionsKey, this.RETENTION_HOURS * 60 * 60);

            this.logger.debug(`[RecentSessions] Added session ${sessionId} to recent sessions (duplicates prevented)`, {
                sessionId,
                startTimestamp,
                metadata: sessionMetadata
            });

            // Clean up old sessions
            await this.cleanupOldSessions();

            return { success: true };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to add session ${sessionId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Remove a session from the recent sessions tracker
     * Optimized for duplicate prevention - silently removes all matching entries
     * @param {string} sessionId - Session ID to remove
     */
    async removeSession(sessionId) {
        try {
            // Get all sessions and remove any that match the sessionId
            const allSessions = await this.redis.zrange(this.recentSessionsKey, 0, -1);
            let removedCount = 0;
            
            for (const sessionDataStr of allSessions) {
                try {
                    const sessionData = JSON.parse(sessionDataStr);
                    if (sessionData.sessionId === sessionId) {
                        await this.redis.zrem(this.recentSessionsKey, sessionDataStr);
                        removedCount++;
                    }
                } catch (parseError) {
                    this.logger.warn(`[RecentSessions] Failed to parse session data during removal: ${parseError.message}`);
                    // Remove unparseable entries
                    await this.redis.zrem(this.recentSessionsKey, sessionDataStr);
                }
            }

            if (removedCount > 0) {
                this.logger.debug(`[RecentSessions] Removed ${removedCount} entries for session ${sessionId}${removedCount > 1 ? ' (prevented duplicates)' : ''}`);
            }

            return { success: true, removedCount };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to remove session ${sessionId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get recent sessions within the last N hours
     * @param {number} hours - Number of hours to look back (default: 1 hour for "active")
     * @returns {Object} Recent sessions data
     */
    async getRecentSessions(hours = 1) {
        try {
            const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
            
            // Get sessions newer than cutoff time
            const recentSessionsData = await this.redis.zrangebyscore(
                this.recentSessionsKey, 
                cutoffTime, 
                '+inf'
            );

            const recentSessions = [];
            for (const sessionDataStr of recentSessionsData) {
                try {
                    const sessionData = JSON.parse(sessionDataStr);
                    recentSessions.push(sessionData);
                } catch (parseError) {
                    this.logger.warn(`[RecentSessions] Failed to parse session data: ${parseError.message}`);
                }
            }

            this.logger.debug(`[RecentSessions] Found ${recentSessions.length} sessions within last ${hours} hours`);

            return {
                success: true,
                sessions: recentSessions,
                count: recentSessions.length,
                hoursBack: hours,
                cutoffTime
            };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to get recent sessions:`, error);
            return {
                success: false,
                error: error.message,
                sessions: [],
                count: 0
            };
        }
    }

    /**
     * Get active sessions (within last hour by default)
     * NOTE: This returns sessions that were marked as active, but you should verify
     * their current status in Redis for accuracy.
     * @param {number} activeThresholdMinutes - Minutes to consider "active" (default: 60)
     */
    async getActiveSessions(activeThresholdMinutes = 60) {
        const hours = activeThresholdMinutes / 60;
        const allRecentSessions = await this.getRecentSessions(hours);
        
        if (!allRecentSessions.success) {
            return allRecentSessions;
        }
        
        // Filter for sessions that might still be active
        // Note: Status in RecentSessionsManager might be stale, so caller should verify
        const potentiallyActiveSessions = allRecentSessions.sessions.filter(session => {
            const status = session.status || 'unknown';
            return ['starting', 'active', 'running'].includes(status.toLowerCase());
        });
        
        return {
            ...allRecentSessions,
            sessions: potentiallyActiveSessions,
            count: potentiallyActiveSessions.length,
            note: 'These sessions were marked as active in RecentSessionsManager. Verify current status in Redis for accuracy.'
        };
    }

    /**
     * Update session metadata (e.g., status change)
     * This is the PREFERRED way to handle session status changes instead of removing sessions.
     * @param {string} sessionId - Session ID
     * @param {Object} updates - Updates to apply
     */
    async updateSession(sessionId, updates) {
        try {
            // Get all sessions and find the one to update
            const allSessions = await this.redis.zrange(this.recentSessionsKey, 0, -1, 'WITHSCORES');
            
            for (let i = 0; i < allSessions.length; i += 2) {
                const sessionDataStr = allSessions[i];
                const score = allSessions[i + 1];
                
                try {
                    const sessionData = JSON.parse(sessionDataStr);
                    if (sessionData.sessionId === sessionId) {
                        // Update the session data
                        const updatedSessionData = {
                            ...sessionData,
                            ...updates,
                            lastUpdated: Date.now()
                        };

                        // Remove old entry and add updated one
                        await this.redis.zrem(this.recentSessionsKey, sessionDataStr);
                        await this.redis.zadd(this.recentSessionsKey, score, JSON.stringify(updatedSessionData));
                        
                        this.logger.debug(`[RecentSessions] Updated session ${sessionId}`, updates);
                        return { success: true };
                    }
                } catch (parseError) {
                    this.logger.warn(`[RecentSessions] Failed to parse session data: ${parseError.message}`);
                }
            }

            this.logger.debug(`[RecentSessions] Session ${sessionId} not found for update`);
            return { success: false, error: 'Session not found' };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to update session ${sessionId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Mark a session as completed (preferred over removeSession)
     * @param {string} sessionId - Session ID
     * @param {string} endReason - Reason for completion
     */
    async markSessionCompleted(sessionId, endReason = 'completed') {
        return await this.updateSession(sessionId, {
            status: 'complete',
            endReason,
            completedAt: Date.now()
        });
    }

    /**
     * Mark a session as failed (preferred over removeSession)
     * @param {string} sessionId - Session ID
     * @param {string} errorReason - Reason for failure
     */
    async markSessionFailed(sessionId, errorReason) {
        return await this.updateSession(sessionId, {
            status: 'failed',
            errorReason,
            failedAt: Date.now()
        });
    }

    /**
     * Clean up sessions older than retention period
     * This is the primary method for removing old sessions - keeps the 72-hour window clean
     */
    async cleanupOldSessions() {
        try {
            const cutoffTime = Date.now() - this.RETENTION_MS;
            const removedCount = await this.redis.zremrangebyscore(this.recentSessionsKey, '-inf', cutoffTime);
            
            if (removedCount > 0) {
                this.logger.info(`[RecentSessions] Cleaned up ${removedCount} old sessions (older than ${this.RETENTION_HOURS}h)`);
            }

            return { success: true, removedCount };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to cleanup old sessions:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get statistics about recent sessions with breakdown by status
     */
    async getStats() {
        try {
            const total = await this.redis.zcard(this.recentSessionsKey);
            const last1Hour = await this.getRecentSessions(1);
            const last6Hours = await this.getRecentSessions(6);
            const last24Hours = await this.getRecentSessions(24);
            const last72Hours = await this.getRecentSessions(72);

            // Analyze session statuses in the last 24 hours
            const statusCounts = { active: 0, complete: 0, failed: 0, starting: 0, unknown: 0 };
            if (last24Hours.success) {
                for (const session of last24Hours.sessions) {
                    const status = (session.status || 'unknown').toLowerCase();
                    if (statusCounts.hasOwnProperty(status)) {
                        statusCounts[status]++;
                    } else {
                        statusCounts.unknown++;
                    }
                }
            }

            return {
                success: true,
                stats: {
                    totalRecentSessions: total,
                    last1Hour: last1Hour.count,
                    last6Hours: last6Hours.count,
                    last24Hours: last24Hours.count,
                    last72Hours: last72Hours.count,
                    retentionHours: this.RETENTION_HOURS,
                    statusBreakdown24h: statusCounts
                }
            };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to get stats:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if a specific session is in recent sessions
     * @param {string} sessionId - Session ID to check
     */
    async hasSession(sessionId) {
        try {
            const allSessions = await this.redis.zrange(this.recentSessionsKey, 0, -1);
            
            for (const sessionDataStr of allSessions) {
                try {
                    const sessionData = JSON.parse(sessionDataStr);
                    if (sessionData.sessionId === sessionId) {
                        return { success: true, found: true, sessionData };
                    }
                } catch (parseError) {
                    this.logger.warn(`[RecentSessions] Failed to parse session data: ${parseError.message}`);
                }
            }

            return { success: true, found: false };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to check session ${sessionId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Emergency cleanup - remove all recent sessions data
     * WARNING: This removes ALL session tracking data. Use with caution.
     */
    async clearAll() {
        try {
            await this.redis.del(this.recentSessionsKey);
            this.logger.warn(`[RecentSessions] EMERGENCY: Cleared all recent sessions data`);
            return { success: true };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to clear all sessions:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Remove duplicate sessions from the recent sessions set
     * This method finds sessions with the same sessionId and keeps only the most recent one
     */
    async removeDuplicates() {
        try {
            const allSessions = await this.redis.zrange(this.recentSessionsKey, 0, -1, 'WITHSCORES');
            
            const sessionMap = new Map();
            const duplicatesRemoved = [];
            
            // Process all sessions to find duplicates
            for (let i = 0; i < allSessions.length; i += 2) {
                const sessionDataStr = allSessions[i];
                const score = parseFloat(allSessions[i + 1]);
                
                try {
                    const sessionData = JSON.parse(sessionDataStr);
                    const sessionId = sessionData.sessionId;
                    
                    if (sessionMap.has(sessionId)) {
                        // Found duplicate - compare timestamps to keep the most recent
                        const existing = sessionMap.get(sessionId);
                        const existingTimestamp = existing.sessionData.lastUpdated || existing.sessionData.addedAt || existing.score;
                        const currentTimestamp = sessionData.lastUpdated || sessionData.addedAt || score;
                        
                        if (currentTimestamp > existingTimestamp) {
                            // Current is more recent - remove existing and keep current
                            await this.redis.zrem(this.recentSessionsKey, existing.sessionDataStr);
                            duplicatesRemoved.push(sessionId);
                            sessionMap.set(sessionId, { sessionDataStr, score, sessionData });
                            this.logger.debug(`[RecentSessions] Removed older duplicate for session ${sessionId}`);
                        } else {
                            // Existing is more recent - remove current
                            await this.redis.zrem(this.recentSessionsKey, sessionDataStr);
                            duplicatesRemoved.push(sessionId);
                            this.logger.debug(`[RecentSessions] Removed newer duplicate for session ${sessionId}`);
                        }
                    } else {
                        // First occurrence of this session ID
                        sessionMap.set(sessionId, { sessionDataStr, score, sessionData });
                    }
                } catch (parseError) {
                    this.logger.warn(`[RecentSessions] Failed to parse session data during duplicate cleanup: ${parseError.message}`);
                    // Remove unparseable entries
                    await this.redis.zrem(this.recentSessionsKey, sessionDataStr);
                }
            }
            
            const uniqueDuplicates = [...new Set(duplicatesRemoved)];
            
            if (uniqueDuplicates.length > 0) {
                this.logger.info(`[RecentSessions] Removed duplicates for ${uniqueDuplicates.length} sessions: ${uniqueDuplicates.join(', ')}`);
            } else {
                this.logger.debug(`[RecentSessions] No duplicates found in recent sessions`);
            }
            
            return { 
                success: true, 
                duplicatesRemoved: uniqueDuplicates.length,
                sessionIds: uniqueDuplicates
            };
        } catch (error) {
            this.logger.error(`[RecentSessions] Failed to remove duplicates:`, error);
            return { success: false, error: error.message };
        }
    }
} 