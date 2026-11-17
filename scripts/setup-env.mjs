import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
let text=existsSync('.env')?readFileSync('.env','utf8'):readFileSync('.env.example','utf8');
let env=parseEnv(text);
if(!env.POSTGRES_PASSWORD||env.POSTGRES_PASSWORD==='replace_with_a_random_password'){
  const password=randomBytes(24).toString('hex');
  text=/^POSTGRES_PASSWORD=/m.test(text)?text.replace(/^POSTGRES_PASSWORD=.*$/m,'POSTGRES_PASSWORD='+password):text+'\nPOSTGRES_PASSWORD='+password+'\n';
}
env=parseEnv(text);
if(!env.DATABASE_URL||env.DATABASE_URL.includes('replace_with_a_random_password')){
  const url='postgresql://hub:'+encodeURIComponent(env.POSTGRES_PASSWORD)+'@127.0.0.1:5433/merchant_content_hub';
  text=/^DATABASE_URL=/m.test(text)?text.replace(/^DATABASE_URL=.*$/m,'DATABASE_URL='+url):text+'\nDATABASE_URL='+url+'\n';
}
writeFileSync('.env',text);chmodSync('.env',0o600);
console.log('.env ready; existing AI/ASR configuration preserved. Database credentials were not printed.');
