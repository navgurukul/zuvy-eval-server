// import OpenAI from 'openai';

// const openai = new OpenAI({
//   baseURL: 'https://api.deepseek.com',
//   apiKey: process.env.DEEPSEEK_API_KEY,
// });

// export async function deepseekResponse(prompt: string) {
//   try {
//     if (!process.env.DEEPSEEK_API_KEY) {
//       throw new Error('Missing DEEPSEEK_API_KEY');
//     }

//     console.log('🔹 DeepSeek request started...');
//     console.log('Prompt:', prompt.slice(0, 200)); // preview first 200 chars

//     const completion = await openai.chat.completions.create({
//       messages: [{ role: 'system', content: prompt }],
//       model: 'deepseek-chat',
//     });

//     const result = completion?.choices?.[0]?.message?.content ?? '';
//     console.log('✅ DeepSeek response received');
//     return result;
//   } catch (err: any) {
//     console.error('❌ DeepSeek request failed');
//     console.error('Error name:', err.name);
//     console.error('Error message:', err.message);
//     console.error('Error details:', err.response?.data || err.stack || err);
//     throw err;
//   }
// }
