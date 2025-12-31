import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Funciones de OAuth 1.0a
function getTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}
function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for(let i = 0; i < 32; i++){
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c)=>'%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function generateSignatureBaseString(method, url, params) {
  const sortedParams = Object.keys(params).sort().map((key)=>`${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
}
function generateSigningKey(consumerSecret, tokenSecret = '') {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}
async function generateSignature(baseString, signingKey) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), {
    name: 'HMAC',
    hash: 'SHA-1'
  }, false, [
    'sign'
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(baseString));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
async function generateOAuthHeader(method, url, consumerKey, consumerSecret, accessToken, accessTokenSecret, additionalParams = {}) {
  const timestamp = getTimestamp();
  const nonce = getNonce();
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_token: accessToken,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_nonce: nonce,
    oauth_version: '1.0',
    ...additionalParams
  };
  const baseString = generateSignatureBaseString(method, url, oauthParams);
  const signingKey = generateSigningKey(consumerSecret, accessTokenSecret);
  const signature = await generateSignature(baseString, signingKey);
  oauthParams.oauth_signature = signature;
  const authHeader = 'OAuth ' + Object.keys(oauthParams).map((key)=>`${percentEncode(key)}="${percentEncode(oauthParams[key])}"`).join(', ');
  return authHeader;
}
async function uploadMedia(imageUrl, consumerKey, consumerSecret, accessToken, accessTokenSecret) {
  try {
    // 1. Fetch the image
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) throw new Error(`Failed to fetch image: ${imageRes.statusText}`);
    const imageBlob = await imageRes.blob();

    // 2. Upload to Twitter
    const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';
    const formData = new FormData();
    formData.append('media', imageBlob);

    // OAuth 1.0a for upload
    // Note: for multipart/form-data, body parameters are NOT included in the signature
    const authHeader = await generateOAuthHeader('POST', uploadUrl, consumerKey, consumerSecret, accessToken, accessTokenSecret);

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        // Do NOT set Content-Type, fetch sets it with boundary
      },
      body: formData
    });

    if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Media upload failed: ${uploadRes.status} ${errText}`);
    }

    const uploadData = await uploadRes.json();
    return uploadData.media_id_string;
  } catch (e) {
    console.error('Error uploading media:', e);
    return null;
  }
}
serve(async (req)=>{
  // Manejar CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Inicializar Supabase client
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    // Verificar límites de API antes de proceder
    const canProceed = await checkApiLimits(supabase);
    if (!canProceed) {
      return new Response(JSON.stringify({
        error: 'Límites de API alcanzados para este mes'
      }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Obtener noticias de Perplexity API
    const internationalNews = await getPerplexityNews('noticias internacionales más relevantes hoy', 'international');
    const nationalNews = await getPerplexityNews('noticias nacionales España más relevantes hoy', 'national');
    if (!internationalNews && !nationalNews) {
      return new Response(JSON.stringify({
        error: 'No se pudieron obtener noticias'
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Filtrar noticias nuevas (no duplicadas)
    const newNews = await filterNewNews(supabase, [
      ...internationalNews || [],
      ...nationalNews || []
    ]);
    if (newNews.length === 0) {
      return new Response(JSON.stringify({
        message: 'No hay noticias nuevas para publicar'
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Obtener credenciales para uploadMedia
    const consumerKey = Deno.env.get('TWITTER_API_KEY');
    const consumerSecret = Deno.env.get('TWITTER_API_SECRET');
    const accessToken = Deno.env.get('TWITTER_ACCESS_TOKEN');
    const accessTokenSecret = Deno.env.get('TWITTER_ACCESS_TOKEN_SECRET');

    // Procesar cada noticia individualmente
    const results = [];
    for (const newsItem of newNews) {
      // Verificar límites antes de procesar cada noticia
      if (!await checkApiLimits(supabase)) {
        console.log('Límite de API alcanzado durante el procesamiento');
        break;
      }

      // Generar hilo específico para esta noticia
      const tweets = await generateThreadForNews(newsItem);

      // Subir imagen si existe
      let mediaId = null;
      if (newsItem.image_url && consumerKey && consumerSecret && accessToken && accessTokenSecret) {
        mediaId = await uploadMedia(newsItem.image_url, consumerKey, consumerSecret, accessToken, accessTokenSecret);
      }

      // Publicar hilo
      const result = await publishTwitterThread(supabase, tweets, mediaId);
      results.push(result);

      // Actualizar contadores
      await updateApiUsage(supabase, 'perplexity', 1);
      await updateApiUsage(supabase, 'twitter', tweets.length);
    }

    // Guardar noticias en cache
    await saveNewsToCache(supabase, newNews);

    return new Response(JSON.stringify({
      message: 'Noticias procesadas',
      published_count: results.length,
      details: results
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error en edge function:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
async function checkApiLimits(supabase) {
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  const { data: twitterUsage } = await supabase.from('api_usage').select('requests_count').eq('service', 'twitter').eq('month_year', currentMonth).single();
  // Límite de Twitter API free: 500 posts por mes
  if (twitterUsage && twitterUsage.requests_count >= 450) {
    return false;
  }
  return true;
}
async function getPerplexityNews(query, type) {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('PERPLEXITY_API_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: `Eres un periodista experto. Proporciona exactamente 2 ${query} en formato JSON con esta estructura:
[{"title": "título", "description": "resumen breve sin citas ni fuentes", "url": "url si disponible", "image_url": "url de imagen relevante si disponible", "published_date": "fecha si disponible"}]

Solo responde con el JSON válido, sin explicaciones adicionales.`
          },
          {
            role: 'user',
            content: `Dame las 2 ${query}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      })
    });
    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }
    const data = await response.json();
    const content = data.choices[0].message.content;
    // Extraer JSON del contenido
    const jsonMatch = content.match(/\[.*\]/s);
    if (!jsonMatch) {
      throw new Error('No se pudo extraer JSON válido de la respuesta');
    }
    const newsItems = JSON.parse(jsonMatch[0]);
    // Añadir tipo a cada noticia
    return newsItems.map((item)=>({
        ...item,
        type
      }));
  } catch (error) {
    console.error(`Error obteniendo noticias ${type}:`, error);
    return null;
  }
}
async function filterNewNews(supabase, allNews) {
  const newNews = [];
  for (const news of allNews){
    // Crear hash único del contenido
    const contentHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(news.title + news.description));
    const hashString = Array.from(new Uint8Array(contentHash)).map((b)=>b.toString(16).padStart(2, '0')).join('');
    // Verificar si ya existe
    const { data: existing } = await supabase.from('news_cache').select('id').eq('content_hash', hashString).single();
    if (!existing) {
      newNews.push({
        ...news,
        content_hash: hashString
      });
    }
  }
  return newNews;
}
async function saveNewsToCache(supabase, news) {
  for (const item of news){
    await supabase.from('news_cache').insert({
      title: item.title,
      description: item.description,
      url: item.url,
      published_date: item.published_date ? new Date(item.published_date) : null,
      type: item.type,
      content_hash: item.content_hash
    });
  }
}
async function generateThreadForNews(newsItem) {
  try {
    const newsText = `Título: ${newsItem.title}\nDescripción: ${newsItem.description}\nFuente: ${newsItem.url || 'No disponible'}`;
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('PERPLEXITY_API_KEY')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: `Crea un hilo de Twitter de 4 a 6 tweets sobre la noticia proporcionada.

Reglas:
- Entra en detalle y explica el contexto.
- Cada tweet máximo 280 caracteres.
- NO uses formato Markdown (nada de negritas **text**, ni cursivas *text*). Usa solo texto plano.
- NO incluyas citas, referencias ni números de fuentes entre corchetes (ej: [1], [2]).
- El primer tweet debe ser un titular atractivo + introducción.
- El último tweet una conclusión o pregunta para la audiencia.
- Usa emojis pero no abuses.
- Responde solo con los tweets separados por "---"`
          },
          {
            role: 'user',
            content: `Noticia:\n${newsText}`
          }
        ],
        temperature: 0.7,
        max_tokens: 1000
      })
    });
    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }
    const data = await response.json();
    const content = data.choices[0].message.content;
    // Dividir el contenido en tweets individuales
    const tweets = content.split('---').map((tweet)=>tweet.trim()).filter((tweet)=>tweet.length > 0);
    return tweets;
  } catch (error) {
    console.error('Error generando hilo de Twitter:', error);
    throw error;
  }
}
async function publishTwitterThread(supabase, tweets, mediaId = null) {
  // Obtener credenciales OAuth de los secrets
  const consumerKey = Deno.env.get('TWITTER_API_KEY');
  const consumerSecret = Deno.env.get('TWITTER_API_SECRET');
  const accessToken = Deno.env.get('TWITTER_ACCESS_TOKEN');
  const accessTokenSecret = Deno.env.get('TWITTER_ACCESS_TOKEN_SECRET');
  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    throw new Error('Faltan credenciales de Twitter OAuth 1.0a');
  }
  // Crear entrada en twitter_threads
  const { data: thread, error: threadError } = await supabase.from('twitter_threads').insert({
    thread_topic: `Noticias ${new Date().toLocaleDateString('es-ES')}`,
    posts_count: tweets.length,
    posts_published: 0
  }).select().single();
  if (threadError) {
    throw new Error(`Error creando thread: ${threadError.message}`);
  }
  let postsPublished = 0;
  let lastTweetId = null;
  // Publicar tweets uno por uno usando OAuth 1.0a
  for(let i = 0; i < tweets.length; i++){
    try {
      const tweetData: any = {
        text: tweets[i]
      };

      // Si es el primer tweet y tenemos mediaId, adjuntarlo
      if (i === 0 && mediaId) {
        tweetData.media = { media_ids: [mediaId] };
      }

      // Si no es el primer tweet, añadir reply_to_tweet_id
      if (lastTweetId) {
        tweetData.reply = {
          in_reply_to_tweet_id: lastTweetId
        };
      }
      // Generar header OAuth 1.0a
      const authHeader = await generateOAuthHeader('POST', 'https://api.twitter.com/2/tweets', consumerKey, consumerSecret, accessToken, accessTokenSecret);
      const response = await fetch('https://api.twitter.com/2/tweets', {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(tweetData)
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Twitter API error: ${response.status} - ${JSON.stringify(errorData)}`);
      }
      const tweetResponse = await response.json();
      lastTweetId = tweetResponse.data.id;
      // Guardar en twitter_posts
      await supabase.from('twitter_posts').insert({
        thread_id: thread.id,
        content: tweets[i],
        tweet_id: lastTweetId,
        position: i + 1
      });
      postsPublished++;
      // Si es el primer tweet, actualizar first_tweet_id
      if (i === 0) {
        await supabase.from('twitter_threads').update({
          first_tweet_id: lastTweetId
        }).eq('id', thread.id);
      }
      // Pausa entre tweets para evitar rate limiting
      if (i < tweets.length - 1) {
        await new Promise((resolve)=>setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.error(`Error publicando tweet ${i + 1}:`, error);
      break;
    }
  }
  // Actualizar estado del thread
  await supabase.from('twitter_threads').update({
    posts_published: postsPublished,
    status: postsPublished === tweets.length ? 'completed' : 'partial'
  }).eq('id', thread.id);
  return {
    thread_id: thread.id,
    posts_published: postsPublished
  };
}
async function updateApiUsage(supabase, service, count) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const { data: existing } = await supabase.from('api_usage').select('requests_count').eq('service', service).eq('month_year', currentMonth).single();
  if (existing) {
    await supabase.from('api_usage').update({
      requests_count: existing.requests_count + count,
      last_reset: new Date().toISOString()
    }).eq('service', service).eq('month_year', currentMonth);
  } else {
    await supabase.from('api_usage').insert({
      service,
      requests_count: count,
      month_year: currentMonth
    });
  }
}
