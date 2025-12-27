import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encode, decode } from 'https://deno.land/std@0.208.0/encoding/base64.ts'

// --- CONFIGURATION ---
const RENDER_BASE_URL = 'https://mkwhatsapp.onrender.com';

// --- HELPER 1: SPINTAX (Text Uniquifier) ---
function spin(text: string) {
  if (!text) return "";
  return text.replace(/\{([^{}]+)\}/g, (_match, group) => {
    const choices = group.split('|');
    return choices[Math.floor(Math.random() * choices.length)];
  });
}

// --- HELPER 2: LIGHTWEIGHT HASH BUSTER (Byte Injection) ---
// Instead of decoding pixels (Memory Heavy), we append random bytes to the file end.
async function bustMediaHash(base64Data: string, mime: string) {
  if (!mime.startsWith('image/') && !mime.startsWith('video/')) return base64Data;

  try {
    // 1. Decode Base64 to Raw Binary (Uint8Array)
    const originalBytes = decode(base64Data);
    
    // 2. Create a slightly larger buffer (Original + 10-20 random bytes)
    const noiseLength = Math.floor(Math.random() * 10) + 5; 
    const newBytes = new Uint8Array(originalBytes.length + noiseLength);
    
    // 3. Copy original data
    newBytes.set(originalBytes);
    
    // 4. Append Random "Junk" Data at the end
    // Most image viewers/WhatsApp ignore data after the file terminator.
    // But this changes the SHA-256 File Hash completely.
    for (let i = 0; i < noiseLength; i++) {
        newBytes[originalBytes.length + i] = Math.floor(Math.random() * 255);
    }

    console.log(`🎨 Hash Busted: Added ${noiseLength} invisible bytes.`);
    
    // 5. Return new Base64
    return encode(newBytes);

  } catch (e) {
    console.error("⚠️ Hash Busting Failed (Sending Original):", e);
    return base64Data; 
  }
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // 🛡️ ANTI-CRASH: Process fewer items per run to save RAM
  const DYNAMIC_LIMIT = Math.floor(Math.random() * 3) + 1; // 1 to 3 items only

  const { data: queue, error } = await supabase
    .from('campaign_queue')
    .select(`
      id, number, campaign_id,
      campaigns!inner (
        id, session_id, message, 
        media_data, media_mime, media_name,
        status
      )
    `)
    .eq('status', 'pending')
    .eq('campaigns.status', 'running')
    .limit(DYNAMIC_LIMIT)

  if (!queue || queue.length === 0) {
    try { await fetch(`${RENDER_BASE_URL}/api/init`); } catch(e) {}
    return new Response(JSON.stringify({ msg: 'Idle' }), { headers: { 'Content-Type': 'application/json' } })
  }

  const results = [];
  const processedCampaigns = new Set();

  for (const item of queue) {
    const campaign = item.campaigns;
    processedCampaigns.add(campaign.id);

    // 🛡️ MEMORY SAFETY: Explicitly nullify large vars after use
    let finalMediaData = null; 

    try {
      const uniqueMessage = spin(campaign.message);

      // Process Media
      if (campaign.media_data) {
          finalMediaData = await bustMediaHash(campaign.media_data, campaign.media_mime);
      }

      // Send to Render
      const res = await fetch(`${RENDER_BASE_URL}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: campaign.session_id,
          number: item.number,
          message: uniqueMessage,
          file: finalMediaData ? {
            data: finalMediaData,
            mimetype: campaign.media_mime,
            filename: campaign.media_name
          } : null
        })
      });

      // Clear memory immediately
      finalMediaData = null; 

      if (!res.ok) throw new Error(`Render Error: ${res.status}`);

      await supabase.from('campaign_queue').update({ status: 'sent', sent_at: new Date() }).eq('id', item.id);
      await supabase.rpc('increment_sent_count', { row_id: campaign.id });
      results.push({ id: item.id, status: 'sent' });

    } catch (e) {
      console.error(`Failed ${item.number}:`, e);
      await supabase.from('campaign_queue').update({ status: 'failed' }).eq('id', item.id);
      results.push({ id: item.id, status: 'failed' });
    }

    if (item !== queue[queue.length - 1]) {
        // Shorter delays for smaller batches
        const delay = Math.floor(Math.random() * 5000) + 5000; 
        await new Promise(r => setTimeout(r, delay));
    }
  }

  for (const campId of processedCampaigns) {
    const { count } = await supabase
        .from('campaign_queue')
        .select('*', { count: 'exact', head: true })
        .eq('campaign_id', campId)
        .eq('status', 'pending');

    if (count === 0) {
        await supabase.from('campaigns').update({ status: 'completed' }).eq('id', campId);
    }
  }

  return new Response(JSON.stringify({ processed: results }), { headers: { 'Content-Type': 'application/json' } })
})
