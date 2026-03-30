# Reflux Fixed - Addon Stremio para Rede Canais

Fork corrigido e simplificado do [Reflux](https://github.com/Nightfruit/reflux) original.

## O que mudou em relação ao original

- **Sem banco de dados** - não precisa mais de PostgreSQL
- **Sem TMDb** - não precisa de chave de API
- **Sem NestJS/Prisma** - código simples em Node.js puro
- **Auto-descoberta de domínio** - testa automaticamente múltiplos domínios do Rede Canais
- **Proxy incluído** - proxy de vídeo embutido no projeto
- **Docker ready** - sobe com um comando

## Instalação Rápida

### Opção 1: Node.js direto

```bash
npm install
npm run start:all
```

### Opção 2: Docker

```bash
docker compose up -d
```

### Opção 3: Rodar separadamente

```bash
# Terminal 1 - Proxy
node proxy.js

# Terminal 2 - Addon
PROXY_URL=http://localhost:3001 node index.js
```

## Instalar no Stremio

Depois de rodar o servidor, adicione o addon no Stremio:

```
http://SEU-IP:3000/manifest.json
```

Ou na mesma máquina:

```
http://localhost:3000/manifest.json
```

## Variáveis de Ambiente

| Variável    | Padrão                  | Descrição                    |
|-------------|-------------------------|------------------------------|
| PORT        | 3000                    | Porta do addon               |
| PROXY_PORT  | 3001                    | Porta do proxy de vídeo      |
| PROXY_URL   | (vazio)                 | URL do proxy (ex: http://localhost:3001) |

## Estrutura

```
index.js     - Addon principal (catálogo, meta, stream)
proxy.js     - Proxy de vídeo (necessário para referer/CORS)
Dockerfile   - Container Docker
docker-compose.yml - Orquestração
```

## Como funciona

1. Na inicialização, testa múltiplos domínios do Rede Canais para encontrar um ativo
2. Faz scraping das páginas de mapa (`/mapafilmes.html` e `/mapa.html`) para listar todo o catálogo
3. Quando o usuário seleciona um conteúdo, descriptografa o JavaScript ofuscado da página para encontrar o player
4. Extrai o token de autenticação e faz POST para obter a URL do vídeo
5. Redireciona via proxy para contornar proteções de referer

## Troubleshooting

### "Nenhum domínio respondeu"
O Rede Canais pode ter mudado todos os domínios. Edite a lista `DOMAINS` no `index.js` com o domínio atual.

### "0 filmes encontrados"
A estrutura HTML do mapa pode ter mudado. Verifique se `/mapafilmes.html` ainda existe acessando no navegador.

### Stream não carrega
Verifique se o proxy está rodando e se `PROXY_URL` está configurado corretamente.

### Cloudflare bloqueando
Se o Rede Canais colocar Cloudflare com desafio JS, o scraping simples não vai funcionar. Nesse caso seria necessário usar puppeteer ou similar.

## Créditos

Baseado no trabalho original de [MrSev7en](https://github.com/MrSev7en) / [Nightfruit](https://github.com/Nightfruit/reflux).
