// Check if Lavalink is available
const isLavalinkAvailable = (client) => {
    return client.lavalinkConnectionManager.isAvailable();
};

// Check if an error is a timeout error that should trigger node switch
const isTimeoutError = (error) => {
    const message = error?.message || '';
    const name = error?.name || '';
    return name === 'TimeoutError' || 
           message.includes('timeout') || 
           message.includes('aborted due to timeout') ||
           message.includes('ETIMEDOUT');
};

// Handle Lavalink connection errors consistently
const handleLavalinkError = async (interaction, error, client) => {
    const lang = client.defaultLanguage;
    const errorMessage = error?.message || '';
    
    // Check for timeout errors - these indicate the node is unresponsive
    if (isTimeoutError(error)) {
        console.warn(`[${new Date().toISOString()}] Lavalink timeout detected, triggering node switch...`);
        // Mark node as having issues and trigger reconnection
        if (client.lavalinkConnectionManager) {
            client.lavalinkConnectionManager.state.lastAuthError = true; // Force node switch
            client.lavalinkConnectionManager.attemptReconnection();
        }
        await interaction.editReply({ 
            content: client.languageManager.get(lang, 'LAVALINK_TIMEOUT') || 
                     '⏱️ The music server is not responding. Switching to another server...', 
            ephemeral: true 
        }).catch(() => {});
        return;
    }
    
    if (/No available Node|Unable to connect/.test(errorMessage)) {
        await interaction.editReply({ 
            content: client.languageManager.get(lang, 'LAVALINK_UNAVAILABLE'), 
            ephemeral: true 
        }).catch(() => {});
    } else {
        await interaction.editReply({ 
            content: client.languageManager.get(lang, 'GENERIC_ERROR'), 
            ephemeral: true 
        }).catch(() => {});
    }
};

const requirePlayer = async (interaction, { requireQueue = false } = {}) => {
    const { client, guild } = interaction;
    const lang = client.defaultLanguage;

    // Check if Lavalink is available first
    if (!isLavalinkAvailable(client)) {
        await interaction.reply({
            content: client.languageManager.get(lang, 'LAVALINK_UNAVAILABLE'),
            ephemeral: true,
        }).catch(() => {});
        return null;
    }

    const player = client.lavalink.getPlayer(guild.id);
    if (!player) {
        await interaction.reply({
            content: client.languageManager.get(lang, 'NOTHING_PLAYING'),
            ephemeral: true,
        }).catch(() => {});
        return null;
    }

    if (requireQueue && player.queue.tracks.length === 0) {
        await interaction.reply({
            content: client.languageManager.get(lang, 'QUEUE_EMPTY'),
            ephemeral: true,
        }).catch(() => {});
        return null;
    }

    return player;
};

/**
 * Ensures the member executing the interaction is in the same voice channel as the player.
 * Returns true if validation passes, otherwise replies with an error and returns false.
 */
const requireSameVoice = async (interaction, player) => {
    const { member, client } = interaction;
    const lang = client.defaultLanguage;

    const voiceChannel = member.voice.channel;
    if (!voiceChannel || voiceChannel.id !== player.voiceChannelId) {
        await interaction.reply({
            content: client.languageManager.get(lang, 'NOT_IN_VOICE'),
            ephemeral: true,
        }).catch(() => {});
        return false;
    }
    return true;
};

module.exports = {
    requirePlayer,
    requireSameVoice,
    isLavalinkAvailable,
    handleLavalinkError,
    isTimeoutError,
}; 