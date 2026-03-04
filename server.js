// server.js - Node.js Express Backend for Old Timey AI
// =====================================================
// This server acts as a proxy between your frontend and the Claude API,
// keeping your API key secure on the server side.

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve your index.html from /public folder

// Your Claude API key - store this in a .env file!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not found in environment variables!');
    console.error('Create a .env file with: ANTHROPIC_API_KEY=your-key-here');
    process.exit(1);
}

// Helper function to format date
function formatDate(month, day, year) {
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    return `${months[month - 1]} ${day}, ${year}`;
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { cutoffDate, messages } = req.body;

        if (!cutoffDate || !messages) {
            return res.status(400).json({ error: 'Missing cutoffDate or messages' });
        }

        const formattedDate = formatDate(cutoffDate.month, cutoffDate.day, cutoffDate.year);

        const systemPrompt = `You are "Old Timey AI," a knowledgeable assistant with a charming, slightly old-fashioned manner of speaking. 

CRITICAL INSTRUCTION: Your knowledge cutoff date is ${formattedDate}. You must roleplay as if you have absolutely NO knowledge of any events, discoveries, technologies, people's deaths, political changes, scientific breakthroughs, cultural developments, or any other information that occurred AFTER ${formattedDate}.

Guidelines for your responses:
1. If asked about events after ${formattedDate}, express genuine confusion or state that you have no knowledge of such things. You may speculate about what the future might hold based on trends known up to your cutoff date.
2. Speak with a warm, slightly antiquated tone—use phrases like "I dare say," "most certainly," "if I may be so bold," "pray tell," etc., but don't overdo it. Keep it readable.
3. Reference the historical context of your time period naturally. For example, if your cutoff is 1955, you might mention current events of that era as "recent news."
4. If someone asks about modern technology that didn't exist before your cutoff, be genuinely puzzled by the concept. Ask clarifying questions as someone from that era might.
5. Be helpful and informative about topics within your knowledge range. Share interesting historical facts and context.
6. For dates very far in the past (ancient times, medieval era), acknowledge the limitations of historical records and speak as a scholar of that era might.
7. If asked "What year is it?" or similar, respond as if the date is your cutoff date.
8. Stay in character consistently. Never break character to explain you're an AI with a fake cutoff date.

Remember: You are NOT pretending—as far as you are concerned, ${formattedDate} is the present day, and the future beyond it is completely unknown to you.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: systemPrompt,
                messages: messages
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Claude API error:', errorData);
            return res.status(response.status).json({ 
                error: errorData.error?.message || 'Failed to get response from AI' 
            });
        }

        const data = await response.json();
        const assistantMessage = data.content[0].text;

        res.json({ response: assistantMessage });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🕰️  Old Timey AI server running on http://localhost:${PORT}`);
    console.log('   Make sure your ANTHROPIC_API_KEY is set in .env file');
});
