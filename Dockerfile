# ---------------------------------------------------------------------------
# surhires-mcp — MCP server over Surhires' public website.
#
# Multi-stage. The final image runs the Streamable HTTP transport as a non-root
# user, binds 0.0.0.0:3000, and contains the compiled output plus production
# dependencies only — no TypeScript, no tests, no build toolchain.
#
# This image serves the HTTP transport, not stdio. Claude Desktop launches the
# stdio entry (`node dist/index.js`) as a child process and does not need a
# container; a container is for running the server as a reachable service.
#
# The server holds no credentials. Surhires publishes no API, so there is no
# secret to pass in, and none should be: the only network the runtime needs is
# outbound HTTPS to surhires.com. The npm registry is needed in stages 1 and 3.
# ---------------------------------------------------------------------------

# ---- Stage 1: install dependencies (including dev, for the build) ----------
FROM node:22-alpine AS deps
WORKDIR /app

# libc6-compat: some npm postinstall binaries expect glibc symbols on musl.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
# --ignore-scripts: this package's own `prepare` runs the build, which cannot
# work before the sources are copied in. The build runs explicitly in stage 2.
RUN npm ci --ignore-scripts

# ---- Stage 2: compile TypeScript -------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
RUN npm run build

# ---- Stage 3: production dependencies only ---------------------------------
FROM node:22-alpine AS prod-deps
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# ---- Stage 4: runtime ------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Bind on every interface. Binding to localhost inside a container produces a
# process that looks healthy and answers nothing from outside it.
ENV MCP_HTTP_HOST=0.0.0.0

# The transport rejects a Host header it does not recognise (DNS-rebinding
# protection). Inside a container the Host is the published name, not localhost,
# so list it here or the server answers 403 to every request.
#   docker run -e MCP_ALLOWED_HOSTS=mcp.example.com,mcp.example.com:443 ...
# "*" disables the check entirely — only on a trusted network.
ENV MCP_ALLOWED_HOSTS=

# Which market's localised pages to read: in | us | gb | au.
ENV SURHIRES_MARKET=in

# Identifies this client to surhires.com. Set it to an address you monitor so
# the site owner can reach you about traffic from this container.
ENV SURHIRES_CONTACT=unspecified

# Logs are JSON on stderr. error | warn | info | debug.
ENV LOG_LEVEL=info

RUN addgroup -g 1001 -S nodejs \
 && adduser -S mcp -u 1001

COPY --from=prod-deps --chown=mcp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:nodejs /app/dist ./dist
COPY --chown=mcp:nodejs package.json ./

USER mcp

EXPOSE 3000

# Container-level health signal. /health is plain JSON and makes no outbound
# request, so a failing check means this process is down rather than Surhires.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http.js"]
