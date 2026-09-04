FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Attestation vars are supplied at promote time; do not default a SHA.
ARG OPENQUICK_SOURCE_REVISION
ARG OPENQUICK_BUILT_AT
ARG OPENQUICK_DEPLOYMENT_ID
ENV OPENQUICK_SOURCE_REVISION=$OPENQUICK_SOURCE_REVISION
ENV OPENQUICK_BUILT_AT=$OPENQUICK_BUILT_AT
ENV OPENQUICK_DEPLOYMENT_ID=$OPENQUICK_DEPLOYMENT_ID
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["npm", "start"]
