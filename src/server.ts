import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import twilio from 'twilio';
import OpenAI from 'openai';

dotenv.config();

const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Health check endpoint for Twilio
app.get('/health', (req, res) => res.send('OK'));

// TwiML endpoint for incoming calls
app.post('/incoming-call', (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const conversationRelay = connect.conversationRelay({
    url: `wss://${req.headers.host}`,
    debug: 'debugging speaker-events tokens-played'  // Enable debug logging
  });
  
  // Add language configuration with a valid Google voice
  conversationRelay.language({
    code: 'en-US',
    ttsProvider: 'google',
    voice: 'en-US-Standard-C'  // Using a standard Google voice
  });
  
  res.type('text/xml');
  res.send(response.toString());
});

// Conversation Relay WebSocket handler
wss.on('connection', (ws) => {
  console.log('Twilio ConversationRelay connected');
  let callSid: string | null = null;

  // Helper function to send text response to Twilio for TTS
  const sendText = (text: string, lang = 'en-US') => {
    if (!text) return;
    // You can stream tokens for lower latency; here we send the whole line.
    const payload = {
      type: 'text',
      token: text,         // ✅ required - using 'token' not 'text'
      last: true,          // ✅ mark this as the last token in this "talk turn"
      lang,                // optional; otherwise TwiML default is used
      interruptible: true, // optional
      preemptible: true    // optional
    };
    console.log('Sending to Twilio for TTS:', text);
    ws.send(JSON.stringify(payload));
  };
  
  // Helper function to get AI response
  const getAIResponse = async (userMessage: string): Promise<string> => {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a helpful voice assistant. Keep responses concise and conversational." },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 150
      });
      return completion.choices[0]?.message?.content || "I'm sorry, I didn't understand that.";
    } catch (error) {
      console.error('OpenAI error:', error);
      return "I'm having trouble processing that request. Please try again.";
    }
  };

  ws.on('message', async (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Received:', msg.type, msg);
    
    switch (msg.type) {
      case 'setup':
        // Initial setup from Twilio - this is when the call connects
        callSid = msg.callSid;
        console.log('Call SID:', callSid);
        console.log('From:', msg.from);
        console.log('To:', msg.to);
        
        // Send initial greeting after setup
        sendText('Hello! Welcome to the voice assistant. How can I help you today?');
        break;

      case 'prompt':
        // User spoke something - msg.voicePrompt contains the transcribed text
        if (msg.voicePrompt) {
          const userMessage = msg.voicePrompt;
          console.log('User said:', userMessage);
          console.log('Language:', msg.lang);
          
          // Get AI response from OpenAI
          const aiResponse = await getAIResponse(userMessage);
          console.log('AI response:', aiResponse);
          sendText(aiResponse);
        }
        break;

      case 'interrupt':
        // User interrupted the assistant while it was speaking
        console.log('User interrupted');
        console.log('Utterance until interrupt:', msg.utteranceUntilInterrupt);
        console.log('Duration until interrupt (ms):', msg.durationUntilInterruptMs);
        // Handle interruption - stop any ongoing processing
        break;

      case 'dtmf':
        // User pressed a phone key
        console.log('DTMF digit received:', msg.digit);
        sendText(`You pressed ${msg.digit}`);
        break;

      case 'error':
        // Error from Twilio
        console.error('Error from Twilio:', msg.description || msg.message || msg);
        break;

      case 'stop':
        // Call ended
        console.log('Call ended');
        break;
    }
  });

  ws.on('close', (code, reason) => {
    console.log('Twilio ConversationRelay disconnected',
                code, reason?.toString?.() || '');
  });
  ws.on('error', (error) => console.error('WebSocket error:', error));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log('\nTo connect with Twilio:');
  console.log('1. Run: ngrok http 3000');
  console.log('2. Use the ngrok URL in your Twilio Voice webhook');
});