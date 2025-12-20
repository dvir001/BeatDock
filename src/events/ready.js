const { ActivityType } = require('discord.js');
const nodeProvider = require('../utils/LavalinkNodeProvider');

module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        
        // Initialize Lavalink client with client data (sets client.id for voice state handling)
        await client.lavalink.init({ ...client.user });
        
        // Fetch nodes from API and connect
        try {
            await nodeProvider.fetchNodes();
            
            // Start fast connection attempts
            const connected = await fastConnectToNode(client, nodeProvider);
            
            if (connected) {
                // Re-initialize to properly set the 'initiated' flag now that we have a connected node
                await client.lavalink.init({ ...client.user });
                console.log('Lavalink connected successfully');
            }
            
        } catch (error) {
            console.error('Failed to initialize Lavalink:', error.message);
        }
        
        // Initialize the connection manager for ongoing monitoring
        client.lavalinkConnectionManager.initialize();
        
        // No initial presence - will be set when music starts playing
        client.user.setActivity(null);
    },
};

/**
 * Fast startup connection - try nodes until one connects
 */
async function fastConnectToNode(client, provider) {
    const maxAttempts = Math.min(provider.nodes.length, 20) || 10;
    const connectionTimeout = 15000; // 15 seconds per node
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const nodeConfig = attempt === 0 
            ? await provider.initialize()
            : await provider.getNextNode();
        
        if (!nodeConfig) {
            break;
        }
        
        try {
            const connected = await attemptConnection(client, nodeConfig, connectionTimeout);
            
            if (connected) {
                provider.markCurrentNodeWorking();
                return true;
            }
        } catch (error) {
            // Node failed, try next one
            continue;
        }
    }
    
    console.warn('Could not connect to any Lavalink node at startup');
    return false;
}

/**
 * Extract HTTP status code from error message
 */
function extractHttpCode(message) {
    const match = message?.match(/(\d{3})/);
    return match ? match[1] : null;
}

/**
 * Attempt to connect to a single node
 */
function attemptConnection(client, nodeConfig, timeout) {
    return new Promise((resolve, reject) => {
        let resolved = false;
        let timeoutId = null;
        
        const cleanup = () => {
            resolved = true;
            if (timeoutId) clearTimeout(timeoutId);
            // Remove our temporary listeners
            client.lavalink.nodeManager.off('connect', onConnect);
            client.lavalink.nodeManager.off('error', onError);
        };
        
        const onConnect = (node) => {
            if (resolved) return;
            if (node.id === 'main-node' || node.options?.id === 'main-node') {
                cleanup();
                resolve(true);
            }
        };
        
        const onError = (node, error) => {
            if (resolved) return;
            if (node.id === 'main-node' || node.options?.id === 'main-node') {
                cleanup();
                reject(error || new Error('Connection error'));
            }
        };
        
        // Set timeout
        timeoutId = setTimeout(() => {
            if (resolved) return;
            cleanup();
            // Also try to clean up the failed node
            try {
                const node = client.lavalink.nodeManager.nodes.get('main-node');
                if (node) {
                    client.lavalink.nodeManager.nodes.delete('main-node');
                    node.destroy?.();
                }
            } catch (e) {}
            reject(new Error('Connection timeout'));
        }, timeout);
        
        // Add listeners before creating node
        client.lavalink.nodeManager.on('connect', onConnect);
        client.lavalink.nodeManager.on('error', onError);
        
        // Clean up any existing node with same ID first
        try {
            const existingNode = client.lavalink.nodeManager.nodes.get('main-node');
            if (existingNode) {
                client.lavalink.nodeManager.nodes.delete('main-node');
                existingNode.destroy?.();
            }
        } catch (e) {}
        
        // Create and connect the node
        try {
            const node = client.lavalink.nodeManager.createNode(nodeConfig);
            
            // The library should auto-connect, but let's make sure
            if (node && !node.connected && typeof node.connect === 'function') {
                node.connect();
            }
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
} 