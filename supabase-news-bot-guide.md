# Edge Function para Noticias Twitter con Perplexity API

## Estructura de archivos:
```
supabase/
├── functions/
│   └── news-twitter-bot/
│       └── index.ts
├── migrations/
│   └── 001_create_news_bot_tables.sql
└── seed.sql
```

## 1. SQL para crear las tablas necesarias

```sql
-- Crear extensión para UUID si no existe
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabla para almacenar noticias procesadas y evitar duplicados
CREATE TABLE news_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    description TEXT,
    url TEXT,
    published_date TIMESTAMP,
    type TEXT CHECK (type IN ('international', 'national')),
    content_hash TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla para rastrear hilos de Twitter publicados
CREATE TABLE twitter_threads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_topic TEXT NOT NULL,
    posts_count INTEGER NOT NULL DEFAULT 0,
    posts_published INTEGER NOT NULL DEFAULT 0,
    status TEXT CHECK (status IN ('completed', 'partial', 'failed')) DEFAULT 'partial',
    first_tweet_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla para rastrear posts individuales del hilo
CREATE TABLE twitter_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id UUID REFERENCES twitter_threads(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    tweet_id TEXT,
    position INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tabla para controlar límites de uso de APIs
CREATE TABLE api_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service TEXT NOT NULL CHECK (service IN ('twitter', 'perplexity')),
    requests_count INTEGER NOT NULL DEFAULT 0,
    month_year TEXT NOT NULL,
    last_reset TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(service, month_year)
);

-- Índices para optimizar consultas
CREATE INDEX idx_news_cache_content_hash ON news_cache(content_hash);
CREATE INDEX idx_news_cache_type ON news_cache(type);
CREATE INDEX idx_news_cache_created_at ON news_cache(created_at);
CREATE INDEX idx_twitter_threads_status ON twitter_threads(status);
CREATE INDEX idx_api_usage_service_month ON api_usage(service, month_year);
```

## 2. Edge Function principal (index.ts)

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface NewsItem {
  title: string;
  description: string;
  url?: string;
  published_date?: string;
}

interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

serve(async (req) => {
  // Manejar CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Inicializar Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Verificar límites de API antes de proceder
    const canProceed = await checkApiLimits(supabase);
    if (!canProceed) {
      return new Response(
        JSON.stringify({ error: 'Límites de API alcanzados para este mes' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Obtener noticias de Perplexity API
    const internationalNews = await getPerplexityNews('noticias internacionales más relevantes hoy', 'international');
    const nationalNews = await getPerplexityNews('noticias nacionales España más relevantes hoy', 'national');

    if (!internationalNews && !nationalNews) {
      return new Response(
        JSON.stringify({ error: 'No se pudieron obtener noticias' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Filtrar noticias nuevas (no duplicadas)
    const newNews = await filterNewNews(supabase, [...(internationalNews || []), ...(nationalNews || [])]);
    
    if (newNews.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No hay noticias nuevas para publicar' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generar hilo de Twitter con Perplexity
    const twitterThread = await generateTwitterThread(newNews);
    
    // Guardar noticias en cache
    await saveNewsToCache(supabase, newNews);
    
    // Publicar hilo en Twitter
    const threadResult = await publishTwitterThread(supabase, twitterThread);

    // Actualizar contadores de API
    await updateApiUsage(supabase, 'perplexity', 2); // 2 llamadas a Perplexity
    await updateApiUsage(supabase, 'twitter', twitterThread.length);

    return new Response(
      JSON.stringify({
        message: 'Hilo publicado exitosamente',
        thread_id: threadResult.thread_id,
        posts_published: threadResult.posts_published,
        news_count: newNews.length
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error en edge function:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function checkApiLimits(supabase: any): Promise<boolean> {
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  
  const { data: twitterUsage } = await supabase
    .from('api_usage')
    .select('requests_count')
    .eq('service', 'twitter')
    .eq('month_year', currentMonth)
    .single();

  // Límite de Twitter API free: 500 posts por mes
  if (twitterUsage && twitterUsage.requests_count >= 450) { // Dejar margen
    return false;
  }

  return true;
}

async function getPerplexityNews(query: string, type: 'international' | 'national'): Promise<NewsItem[] | null> {
  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('PERPLEXITY_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: `Eres un periodista experto. Proporciona exactamente 5 ${query} en formato JSON con esta estructura:
            [{"title": "título", "description": "resumen breve", "url": "url si disponible", "published_date": "fecha si disponible"}]
            Solo responde con el JSON válido, sin explicaciones adicionales.`
          },
          {
            role: 'user',
            content: `Dame las 5 ${query}`
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data: PerplexityResponse = await response.json();
    const content = data.choices[0].message.content;
    
    // Extraer JSON del contenido
    const jsonMatch = content.match(/\[.*\]/s);
    if (!jsonMatch) {
      throw new Error('No se pudo extraer JSON válido de la respuesta');
    }

    const newsItems = JSON.parse(jsonMatch[0]);
    
    // Añadir tipo a cada noticia
    return newsItems.map((item: NewsItem) => ({ ...item, type }));

  } catch (error) {
    console.error(`Error obteniendo noticias ${type}:`, error);
    return null;
  }
}

async function filterNewNews(supabase: any, allNews: NewsItem[]): Promise<NewsItem[]> {
  const newNews: NewsItem[] = [];
  
  for (const news of allNews) {
    // Crear hash único del contenido
    const contentHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(news.title + news.description)
    );
    const hashString = Array.from(new Uint8Array(contentHash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Verificar si ya existe
    const { data: existing } = await supabase
      .from('news_cache')
      .select('id')
      .eq('content_hash', hashString)
      .single();

    if (!existing) {
      newNews.push({ ...news, content_hash: hashString });
    }
  }

  return newNews;
}

async function saveNewsToCache(supabase: any, news: NewsItem[]): Promise<void> {
  for (const item of news) {
    await supabase
      .from('news_cache')
      .insert({
        title: item.title,
        description: item.description,
        url: item.url,
        published_date: item.published_date ? new Date(item.published_date) : null,
        type: item.type,
        content_hash: item.content_hash
      });
  }
}

async function generateTwitterThread(news: NewsItem[]): Promise<string[]> {
  try {
    const newsText = news.map((item, index) => 
      `${index + 1}. ${item.title}\n${item.description}`
    ).join('\n\n');

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('PERPLEXITY_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: `Crea un hilo de Twitter de exactamente 10 tweets sobre las noticias proporcionadas. 
            Reglas:
            - Cada tweet debe tener máximo 280 caracteres
            - El primer tweet debe ser una introducción atractiva
            - Los tweets 2-9 deben cubrir las noticias más importantes
            - El último tweet debe ser una conclusión
            - Usa emojis relevantes
            - Tono profesional pero cercano
            - Responde solo con los 10 tweets separados por "---"`
          },
          {
            role: 'user',
            content: `Crea un hilo de Twitter con estas noticias:\n\n${newsText}`
          }
        ],
        temperature: 0.7,
        max_tokens: 2000
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data: PerplexityResponse = await response.json();
    const content = data.choices[0].message.content;
    
    // Dividir el contenido en tweets individuales
    const tweets = content.split('---').map(tweet => tweet.trim()).filter(tweet => tweet.length > 0);
    
    // Asegurar que tenemos exactamente 10 tweets
    return tweets.slice(0, 10);

  } catch (error) {
    console.error('Error generando hilo de Twitter:', error);
    throw error;
  }
}

async function publishTwitterThread(supabase: any, tweets: string[]): Promise<{thread_id: string, posts_published: number}> {
  // Crear entrada en twitter_threads
  const { data: thread, error: threadError } = await supabase
    .from('twitter_threads')
    .insert({
      thread_topic: `Noticias ${new Date().toLocaleDateString('es-ES')}`,
      posts_count: tweets.length,
      posts_published: 0
    })
    .select()
    .single();

  if (threadError) {
    throw new Error(`Error creando thread: ${threadError.message}`);
  }

  let postsPublished = 0;
  let lastTweetId = null;

  // Publicar tweets uno por uno
  for (let i = 0; i < tweets.length; i++) {
    try {
      const tweetData: any = {
        text: tweets[i]
      };

      // Si no es el primer tweet, añadir reply_to_tweet_id
      if (lastTweetId) {
        tweetData.reply = {
          in_reply_to_tweet_id: lastTweetId
        };
      }

      const response = await fetch('https://api.twitter.com/2/tweets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('TWITTER_BEARER_TOKEN')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(tweetData),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Twitter API error: ${response.status} - ${JSON.stringify(errorData)}`);
      }

      const tweetResponse = await response.json();
      lastTweetId = tweetResponse.data.id;

      // Guardar en twitter_posts
      await supabase
        .from('twitter_posts')
        .insert({
          thread_id: thread.id,
          content: tweets[i],
          tweet_id: lastTweetId,
          position: i + 1
        });

      postsPublished++;

      // Si es el primer tweet, actualizar first_tweet_id
      if (i === 0) {
        await supabase
          .from('twitter_threads')
          .update({ first_tweet_id: lastTweetId })
          .eq('id', thread.id);
      }

      // Pausa entre tweets para evitar rate limiting
      if (i < tweets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch (error) {
      console.error(`Error publicando tweet ${i + 1}:`, error);
      break;
    }
  }

  // Actualizar estado del thread
  await supabase
    .from('twitter_threads')
    .update({ 
      posts_published: postsPublished,
      status: postsPublished === tweets.length ? 'completed' : 'partial'
    })
    .eq('id', thread.id);

  return {
    thread_id: thread.id,
    posts_published: postsPublished
  };
}

async function updateApiUsage(supabase: any, service: string, count: number): Promise<void> {
  const currentMonth = new Date().toISOString().slice(0, 7);
  
  const { data: existing } = await supabase
    .from('api_usage')
    .select('requests_count')
    .eq('service', service)
    .eq('month_year', currentMonth)
    .single();

  if (existing) {
    await supabase
      .from('api_usage')
      .update({ 
        requests_count: existing.requests_count + count,
        last_reset: new Date().toISOString()
      })
      .eq('service', service)
      .eq('month_year', currentMonth);
  } else {
    await supabase
      .from('api_usage')
      .insert({
        service,
        requests_count: count,
        month_year: currentMonth
      });
  }
}
```

## 3. Configuración de cron-job.org

1. Registrarse en https://cron-job.org
2. Crear un nuevo cronjob con:
   - URL: `https://[tu-proyecto].supabase.co/functions/v1/news-twitter-bot`
   - Método: POST
   - Headers: `Authorization: Bearer [tu-service-role-key]`
   - Frecuencia: Diaria (ej: todos los días a las 8:00 AM)

## 4. Variables de entorno requeridas

En tu proyecto Supabase, añadir estas secrets:

```bash
supabase secrets set PERPLEXITY_API_KEY=your_perplexity_key
supabase secrets set TWITTER_BEARER_TOKEN=your_twitter_bearer_token
```

## 5. Deploy

```bash
supabase functions deploy news-twitter-bot
```

Esta solución:
- ✅ Usa Perplexity API para obtener noticias
- ✅ Evita duplicados con hashing de contenido
- ✅ Genera hilos de 10 tweets
- ✅ Controla límites de API (500 posts/mes Twitter)
- ✅ Funciona con cron-job.org externo
- ✅ Mantiene estado en Supabase
- ✅ Maneja errores gracefully