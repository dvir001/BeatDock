const fs = require('fs');
const path = require('path');

const LAVALINK_LIST_API = process.env.LAVALINK_LIST_API_URL || 'https://lavalink-list.ajieblogs.eu.org/All';
// Use /app/data in production (Docker) or ./data relative to project root in development
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', '..', 'data');
const NODE_CACHE_FILE = path.join(DATA_DIR, 'lavalink-node.json');
const NODES_CACHE_FILE = path.join(DATA_DIR, 'lavalink-nodes.json');

class LavalinkNodeProvider {
    constructor() {
        this.nodes = [];
        this.currentNodeIndex = 0;
        this.currentNode = null;
        this.failedNodes = new Set(); // Track nodes that failed recently
        this.lastFetchTime = 0;
        this.fetchCooldown = 10 * 60 * 1000; // 10 minutes cooldown between API fetches
    }

    /**
     * Ensure the data directory exists
     */
    ensureDataDir() {
        const dataDir = path.dirname(NODE_CACHE_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    /**
     * Load the saved node from file
     * @returns {Object|null} The saved node or null
     */
    loadSavedNode() {
        try {
            if (fs.existsSync(NODE_CACHE_FILE)) {
                const data = fs.readFileSync(NODE_CACHE_FILE, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            // Ignore cache load errors
        }
        return null;
    }

    /**
     * Save the current working node to file
     * @param {Object} node The node to save
     */
    saveNode(node) {
        try {
            this.ensureDataDir();
            fs.writeFileSync(NODE_CACHE_FILE, JSON.stringify(node, null, 2));
        } catch (error) {
            // Ignore cache save errors
        }
    }

    /**
     * Load cached nodes list from file
     * @returns {Array} The cached nodes or empty array
     */
    loadCachedNodes() {
        try {
            if (fs.existsSync(NODES_CACHE_FILE)) {
                const data = fs.readFileSync(NODES_CACHE_FILE, 'utf8');
                const cache = JSON.parse(data);
                // Check if cache is still valid (less than 1 hour old)
                if (cache.timestamp && Date.now() - cache.timestamp < 60 * 60 * 1000) {
                    return cache.nodes;
                }
            }
        } catch (error) {
            // Ignore cache load errors
        }
        return [];
    }

    /**
     * Save nodes list to cache file
     * @param {Array} nodes The nodes to cache
     */
    saveCachedNodes(nodes) {
        try {
            this.ensureDataDir();
            const cache = {
                timestamp: Date.now(),
                nodes: nodes
            };
            fs.writeFileSync(NODES_CACHE_FILE, JSON.stringify(cache, null, 2));
        } catch (error) {
            // Ignore cache save errors
        }
    }

    /**
     * Fetch nodes from the lavalink-list API
     * @returns {Promise<Array>} Array of available nodes
     */
    async fetchNodes() {
        // Check cooldown
        if (Date.now() - this.lastFetchTime < this.fetchCooldown) {
            return this.nodes.length > 0 ? this.nodes : this.loadCachedNodes();
        }

        try {
            
            const response = await fetch(LAVALINK_LIST_API, {
                headers: {
                    'User-Agent': 'BeatDock-Discord-Bot/2.3.0'
                },
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });

            if (!response.ok) {
                throw new Error(`API returned status ${response.status}`);
            }

            const allNodes = await response.json();
            
            // Filter for v4 nodes only (lavalink-client requires v4)
            // Also prioritize SSL nodes for security
            const v4Nodes = allNodes.filter(node => 
                node.version === 'v4' && 
                node.host && 
                node.port && 
                node.password
            ).map(node => ({
                ...node,
                // Infer secure from port if not explicitly set
                secure: node.secure === true || node.port === 443
            }));

            // Sort: SSL nodes first, then by identifier
            v4Nodes.sort((a, b) => {
                if (a.secure && !b.secure) return -1;
                if (!a.secure && b.secure) return 1;
                return 0;
            });

            this.nodes = v4Nodes;
            this.lastFetchTime = Date.now();
            this.saveCachedNodes(v4Nodes);
            
            return v4Nodes;
        } catch (error) {
            
            // Fall back to cached nodes
            const cachedNodes = this.loadCachedNodes();
            if (cachedNodes.length > 0) {
                this.nodes = cachedNodes;
                return cachedNodes;
            }
            
            return [];
        }
    }

    /**
     * Get a node configuration for lavalink-client
     * @param {Object} node Raw node from API
     * @returns {Object} Node configuration for lavalink-client
     */
    formatNodeConfig(node) {
        const port = parseInt(node.port, 10);
        const secure = node.secure === true;
        
        const config = {
            host: node.host,
            port: port,
            authorization: node.password,
            secure: secure,
            id: 'main-node',
            retryAmount: 1,  // Don't retry during fast startup
            retryDelay: 1000,
        };
        
        return config;
    }

    /**
     * Initialize and get the first available node
     * @returns {Promise<Object|null>} Node configuration or null
     */
    async initialize() {
        // First, try to use the saved working node
        const savedNode = this.loadSavedNode();
        if (savedNode) {
            this.currentNode = savedNode;
            return this.formatNodeConfig(savedNode);
        }

        // Fetch fresh nodes from API
        await this.fetchNodes();

        // Get the first available node
        return this.getNextNode();
    }

    /**
     * Mark the current node as failed and get the next one
     * @returns {Promise<Object|null>} Next node configuration or null
     */
    async getNextNode() {
        // Mark current node as failed if it exists
        if (this.currentNode) {
            const nodeKey = `${this.currentNode.host}:${this.currentNode.port}`;
            this.failedNodes.add(nodeKey);
            console.log(`Lavalink node failed: ${nodeKey}`);
        }

        // Refresh nodes if we have none or too many failed
        if (this.nodes.length === 0 || this.failedNodes.size >= this.nodes.length) {
            console.log('Refreshing Lavalink node list...');
            this.failedNodes.clear(); // Reset failed nodes
            this.lastFetchTime = 0; // Force refresh
            await this.fetchNodes();
        }

        // Find the next available node that hasn't failed
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            const nodeKey = `${node.host}:${node.port}`;
            
            if (!this.failedNodes.has(nodeKey)) {
                this.currentNode = node;
                this.currentNodeIndex = i;
                console.log(`Trying Lavalink node: ${nodeKey}`);
                return this.formatNodeConfig(node);
            }
        }

        // If all nodes failed, clear failed list and try again
        console.log('All nodes failed, resetting list...');
        this.failedNodes.clear();
        
        if (this.nodes.length > 0) {
            const node = this.nodes[0];
            this.currentNode = node;
            this.currentNodeIndex = 0;
            console.log(`Retrying first node: ${node.host}:${node.port}`);
            return this.formatNodeConfig(node);
        }

        console.error('No Lavalink nodes available');
        return null;
    }

    /**
     * Mark the current node as working and save it
     */
    markCurrentNodeWorking() {
        if (this.currentNode) {
            const nodeKey = `${this.currentNode.host}:${this.currentNode.port}`;
            this.failedNodes.delete(nodeKey);
            this.saveNode(this.currentNode);
            console.log(`Lavalink node connected: ${nodeKey}`);
        }
    }

    /**
     * Get current node info for status display
     * @returns {Object|null} Current node info
     */
    getCurrentNodeInfo() {
        if (!this.currentNode) return null;
        return {
            host: this.currentNode.host,
            port: this.currentNode.port,
            secure: this.currentNode.secure || false,
            identifier: this.currentNode.identifier || this.currentNode['unique-id']
        };
    }

    /**
     * Get statistics about available nodes
     * @returns {Object} Node statistics
     */
    getStats() {
        return {
            totalNodes: this.nodes.length,
            failedNodes: this.failedNodes.size,
            currentNode: this.getCurrentNodeInfo(),
            lastFetchTime: this.lastFetchTime
        };
    }
}

// Export singleton instance
module.exports = new LavalinkNodeProvider();
