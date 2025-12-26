const nodeProvider = require('./LavalinkNodeProvider');

// Helper function for ISO 8601 timestamps
const timestamp = () => new Date().toISOString();

class LavalinkConnectionManager {
    constructor(client) {
        this.client = client;
        this.nodeProvider = nodeProvider;
        this.state = {
            reconnectAttempts: 0,
            maxReconnectAttempts: parseInt(process.env.LAVALINK_MAX_RECONNECT_ATTEMPTS || "10", 10),
            baseDelay: parseInt(process.env.LAVALINK_BASE_DELAY_MS || "1000", 10),
            maxDelay: parseInt(process.env.LAVALINK_MAX_DELAY_MS || "30000", 10),
            reconnectTimer: null,
            healthCheckInterval: null,
            periodicResetInterval: null,
            lastPing: Date.now(),
            isReconnecting: false,
            isWaitingForReset: false, // Track if we're waiting for the 5-minute reset
            isInitialized: false,
            hasHadSuccessfulConnection: false,
            lastAuthError: false // Track if last error was auth-related
        };
    }

    // Check if Lavalink is available
    isAvailable() {
        const mainNode = this.client.lavalink.nodeManager.nodes.get('main-node');
        return mainNode && mainNode.connected;
    }

    // Check if Lavalink manager is ready
    isManagerReady() {
        return this.client.lavalink && this.client.lavalink.nodeManager;
    }

    // Exponential backoff delay calculation
    getReconnectDelay(attempt) {
        const delay = Math.min(this.state.baseDelay * Math.pow(2, attempt), this.state.maxDelay);
        return delay + Math.random() * 1000; // Add jitter
    }

    // Health check function
    startHealthCheck() {
        if (this.state.healthCheckInterval) {
            clearInterval(this.state.healthCheckInterval);
        }
        
        const healthCheckInterval = parseInt(process.env.LAVALINK_HEALTH_CHECK_INTERVAL_MS || "30000", 10);
        let lastHealthStatus = true; // Track if we were healthy last time
        
        this.state.healthCheckInterval = setInterval(() => {
            const mainNode = this.client.lavalink.nodeManager.nodes.get('main-node');
            const isCurrentlyHealthy = mainNode && mainNode.connected;
            
            if (!isCurrentlyHealthy) {
                lastHealthStatus = false;
                this.attemptReconnection();
            } else {
                // Update last ping time if node is connected
                this.state.lastPing = Date.now();
                lastHealthStatus = true;
                
                // Reset reconnection attempts if we're connected and healthy
                if (this.state.reconnectAttempts > 0) {
                    this.state.reconnectAttempts = 0;
                }
            }
        }, healthCheckInterval);
    }

    // Periodic reset function - safety net for long-running disconnections
    startPeriodicReset() {
        if (this.state.periodicResetInterval) {
            clearInterval(this.state.periodicResetInterval);
        }
        
        this.state.periodicResetInterval = setInterval(() => {
            const mainNode = this.client.lavalink.nodeManager.nodes.get('main-node');
            const timeSinceLastPing = Date.now() - this.state.lastPing;
            
            // If we haven't had a successful ping in the last 30 minutes, try reconnecting
            const PING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
            if (!mainNode || !mainNode.connected || timeSinceLastPing > PING_TIMEOUT_MS) {
                this.state.reconnectAttempts = 0; // Reset attempts
                this.attemptReconnection();
            }
        }, 60 * 60 * 1000); // Check every hour
    }

    // Reconnection logic - only switches nodes on auth errors
    async attemptReconnection() {
        if (this.state.isReconnecting) {
            return; // Silently skip if already reconnecting
        }
        
        if (this.state.isWaitingForReset) {
            return; // Silently skip if waiting for the reset timer
        }

        // Check if Lavalink manager is ready
        if (!this.isManagerReady()) {
            return;
        }
        
        this.state.isReconnecting = true;
        
        try {
            const mainNode = this.client.lavalink.nodeManager.nodes.get('main-node');
            
            if (mainNode && mainNode.connected) {
                this.state.isReconnecting = false;
                return;
            }
            
            // Destroy existing node if it exists but is disconnected
            if (mainNode) {
                try {
                    await mainNode.destroy();
                } catch (error) {
                    // Ignore destroy errors
                }
            }
            
            // Only switch to a new node if last error was auth-related
            let nodeConfig;
            if (this.state.lastAuthError) {
                nodeConfig = await this.nodeProvider.getNextNode();
                this.state.lastAuthError = false; // Reset flag
            } else {
                // Use current node config for regular reconnection
                const currentNodeInfo = this.nodeProvider.getCurrentNodeInfo();
                if (currentNodeInfo) {
                    nodeConfig = this.nodeProvider.formatNodeConfig(this.nodeProvider.currentNode);
                } else {
                    // No current node, get one
                    nodeConfig = await this.nodeProvider.initialize();
                }
            }
            
            if (!nodeConfig) {
                throw new Error('No Lavalink nodes available from provider');
            }
            
            // Create new node
            let newNode;
            try {
                newNode = this.client.lavalink.nodeManager.createNode(nodeConfig);
            } catch (error) {
                throw new Error(`Failed to create node: ${error.message}`);
            }
            
            // Validate the created node
            if (!newNode) {
                throw new Error('Node creation failed - no node object returned');
            }
            
            // Wait for connection with proper error handling
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    // Clean up event listeners before rejecting
                    if (typeof newNode.off === 'function') {
                        newNode.off('connect', onConnect);
                        newNode.off('error', onError);
                    }
                    reject(new Error('Connection timeout'));
                }, 15000); // 15 second timeout
                
                const onConnect = () => {
                    clearTimeout(timeout);
                    // Clean up event listeners on success
                    if (typeof newNode.off === 'function') {
                        newNode.off('connect', onConnect);
                        newNode.off('error', onError);
                    }
                    resolve();
                };
                
                const onError = (error) => {
                    clearTimeout(timeout);
                    // Clean up event listeners on error
                    if (typeof newNode.off === 'function') {
                        newNode.off('connect', onConnect);
                        newNode.off('error', onError);
                    }
                    reject(error);
                };
                
                // Check if the node has the event methods
                if (typeof newNode.once === 'function') {
                    newNode.once('connect', onConnect);
                    newNode.once('error', onError);
                } else {
                    // If the node doesn't have event methods, wait a bit and check if it's connected
                    setTimeout(() => {
                        if (newNode.connected) {
                            clearTimeout(timeout);
                            resolve();
                        } else {
                            clearTimeout(timeout);
                            reject(new Error('Node created but not connected'));
                        }
                    }, 2000);
                }
            });
            
            this.state.reconnectAttempts = 0;
            this.state.isReconnecting = false;
            
        } catch (error) {
            this.state.reconnectAttempts++;
            
            if (this.state.reconnectAttempts >= this.state.maxReconnectAttempts) {
                const resetMinutes = parseInt(process.env.LAVALINK_RESET_ATTEMPTS_AFTER_MINUTES || "5", 10);
                console.warn(`[${timestamp()}] Max reconnection attempts reached. Will retry after ${resetMinutes} minutes...`);
                this.state.isReconnecting = false;
                this.state.isWaitingForReset = true; // Prevent further attempts until reset
                
                // Reset attempts after configured period and try again
                const resetDelay = resetMinutes * 60 * 1000;
                
                // Clear any existing timer
                if (this.state.reconnectTimer) {
                    clearTimeout(this.state.reconnectTimer);
                }
                
                this.state.reconnectTimer = setTimeout(() => {
                    this.state.reconnectAttempts = 0;
                    this.state.isReconnecting = false;
                    this.state.isWaitingForReset = false;
                    // Force node switch after cooldown - current node is clearly broken
                    this.state.lastAuthError = true;
                    console.log(`[${timestamp()}] Retrying Lavalink connection after cooldown (switching node)...`);
                    this.attemptReconnection();
                }, resetDelay);
                
                return;
            }
            
            // Schedule next attempt with exponential backoff
            const delay = this.getReconnectDelay(this.state.reconnectAttempts);
            
            this.state.reconnectTimer = setTimeout(() => {
                this.state.isReconnecting = false;
                this.attemptReconnection();
            }, delay);
        }
    }

    // Handle connection events
    onConnect(node) {
        this.state.lastPing = Date.now();
        this.state.reconnectAttempts = 0;
        this.state.nodeRetryAttempts = 0;
        this.state.isReconnecting = false;
        this.state.isWaitingForReset = false; // Clear the waiting state on successful connection
        this.state.isInitialized = true;
        this.state.hasHadSuccessfulConnection = true;
        
        // Mark the current node as working and save it (this logs the connection)
        this.nodeProvider.markCurrentNodeWorking();
        
        // Clear any pending reconnection timers
        if (this.state.reconnectTimer) {
            clearTimeout(this.state.reconnectTimer);
            this.state.reconnectTimer = null;
        }
        
        // Start health check after successful connection (if not already started)
        if (!this.state.healthCheckInterval) {
            this.startHealthCheck();
        }
        
        // Start periodic reset as safety net (if not already started)
        if (!this.state.periodicResetInterval) {
            this.startPeriodicReset();
        }
    }

    onError(node, error) {
        // Don't log or handle errors during startup
        if (!this.state.isInitialized) {
            return;
        }
        
        const errorMsg = error?.message || error?.toString() || '';
        const errorCode = error?.code || '';
        
        console.error(`[${timestamp()}] Lavalink error: ${errorMsg}`);
        
        // Check for authentication errors - these should trigger node switch
        const isAuthError = errorMsg.includes('401') || 
                           errorMsg.includes('403') || 
                           errorMsg.includes('Unauthorized') ||
                           errorMsg.includes('Invalid authorization') ||
                           errorCode === 'ECONNRESET';
        
        if (isAuthError) {
            this.state.lastAuthError = true;
        }
        
        // Only handle errors if we've had a successful connection before
        if (this.state.hasHadSuccessfulConnection) {
            // Trigger reconnection for connection-related errors
            if (isAuthError || errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND' || errorMsg.includes('Unable to connect')) {
                setTimeout(() => this.attemptReconnection(), isAuthError ? 1000 : 5000);
            }
        }
    }

    onDisconnect(node, reason) {
        // Don't log or handle disconnects during startup
        if (!this.state.isInitialized) {
            return;
        }
        
        const reasonStr = reason?.reason || reason?.toString() || 'Unknown';
        
        console.log(`[${timestamp()}] Lavalink disconnected: ${reasonStr}`);
        
        // Check if this was an auth-related disconnect (code 4001 is common for auth)
        const isAuthDisconnect = reason?.code === 4001 || 
                                  reason?.code === 4003 ||
                                  reasonStr.includes('Unauthorized') ||
                                  reasonStr.includes('Invalid authorization');
        
        if (isAuthDisconnect) {
            this.state.lastAuthError = true;
        }
        
        // Only handle disconnects if we've had a successful connection before
        if (this.state.hasHadSuccessfulConnection) {
            // Clear health check interval
            if (this.state.healthCheckInterval) {
                clearInterval(this.state.healthCheckInterval);
                this.state.healthCheckInterval = null;
            }
            
            // Clear periodic reset interval
            if (this.state.periodicResetInterval) {
                clearInterval(this.state.periodicResetInterval);
                this.state.periodicResetInterval = null;
            }
            
            // Attempt reconnection for unexpected disconnections
            if (reasonStr !== 'destroy') {
                let delay = 2000; // Default 2 seconds
                
                if (isAuthDisconnect) {
                    delay = 1000;
                } else if (reasonStr === 'Socket got terminated due to no ping connection') {
                    delay = 5000;
                } else if (reasonStr.includes('timeout')) {
                    delay = 3000;
                }
                
                setTimeout(() => this.attemptReconnection(), delay);
            }
        }
    }

    // Initialize the connection manager after a delay to let Lavalink start up
    initialize() {
        this.state.isInitialized = true;
        this.startMonitoring();
    }

    // Start monitoring for Lavalink availability
    startMonitoring() {
        // Check immediately
        this.checkAndStartHealthChecks();
        
        // Then check every 5 seconds until we get a connection
        const monitoringInterval = setInterval(() => {
            if (this.isAvailable()) {
                clearInterval(monitoringInterval);
                this.startHealthCheck();
                this.startPeriodicReset();
            }
        }, 5000);
        
        // Stop monitoring after 2 minutes if no connection (fallback)
        setTimeout(() => {
            clearInterval(monitoringInterval);
            if (!this.isAvailable()) {
                this.startHealthCheck();
                this.startPeriodicReset();
            }
        }, 120000); // 2 minutes
        
        // Add a longer timeout to warn if Lavalink never starts
        setTimeout(() => {
            if (!this.isAvailable()) {
                console.error(`[${timestamp()}] CRITICAL: Lavalink has not connected after 5 minutes!`);
            }
        }, 300000); // 5 minutes
    }

    // Check if Lavalink is available and start health checks if it is
    checkAndStartHealthChecks() {
        if (this.isAvailable()) {
            this.startHealthCheck();
            this.startPeriodicReset();
            return true;
        }
        return false;
    }

    // Cleanup function
    destroy() {
        if (this.state.reconnectTimer) {
            clearTimeout(this.state.reconnectTimer);
        }
        if (this.state.healthCheckInterval) {
            clearInterval(this.state.healthCheckInterval);
        }
        if (this.state.periodicResetInterval) {
            clearInterval(this.state.periodicResetInterval);
        }
    }

    // Get connection status for status command
    getStatus() {
        const mainNode = this.client.lavalink.nodeManager.nodes.get('main-node');
        const isConnected = mainNode && mainNode.connected;
        const nodeStats = this.nodeProvider.getStats();
        
        return {
            isConnected,
            reconnectAttempts: this.state.reconnectAttempts,
            maxReconnectAttempts: this.state.maxReconnectAttempts,
            nodeRetryAttempts: this.state.nodeRetryAttempts,
            isReconnecting: this.state.isReconnecting,
            lastPing: this.state.lastPing,
            node: mainNode,
            nodeProvider: nodeStats
        };
    }
}

module.exports = LavalinkConnectionManager; 