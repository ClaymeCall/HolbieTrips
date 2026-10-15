import type { FastifyInstance } from 'fastify';
import { loadDestinationPack } from '../destination-pack.js';
import { readText, type RequestBody } from '../lib/request-values.js';
import type { RouteContext } from './context.js';

/** Registers the public destination pack and searchable trip catalogue. */
export function registerCatalogRoutes(app: FastifyInstance, context: RouteContext): void {
  const { pool, settings, flags } = context;

  /** Loads the configured supplier pack and enriches its runtime representation. */
  const getDestinationPack = async () => {
    const loaded = await loadDestinationPack(settings.destinationPackFile, settings.destinationPackSha256);
    if (loaded.integrity.calculated !== loaded.integrity.expected && loaded.integrity.accepted) {
      loaded.pack.destinations = loaded.pack.destinations.map(destination => (
        destination.slug === 'kyoto-saisons'
          ? { ...destination, travelTip: `${destination.travelTip} — ${flags.get('A03')}` }
          : destination
      ));
    }

    if (!loaded.integrity.accepted) {
      throw new Error('Destination pack failed integrity verification');
    }

    return loaded;
  };

  app.get('/api/destination-pack', async (request, reply) => {
    try {
      return await getDestinationPack();
    } catch {
      return reply.code(503).send({ error: 'Destination pack unavailable' });
    }
  });

  app.get('/api/trips', async (request, reply) => {
    const query = readText((request.query as RequestBody).q, 100);

    const filter = query ? ' AND (title ILIKE $1 OR destination ILIKE $1 OR description ILIKE $1)' : '';
    const values = query ? [`%${query}%`] : [];
    const result = await pool.query(
      `SELECT id,slug,title,destination,description,departure_date,return_date,price_cents,seats_available,image_key
       FROM trips
       WHERE is_published=true${filter}
       ORDER BY departure_date`,
      values
    );

    let tips = new Map<string, string>();
    try {
      const { pack } = await getDestinationPack();
      tips = new Map(pack.destinations.map(destination => [destination.slug, destination.travelTip]));
    } catch {
      return reply.code(503).send({ error: 'Destination pack unavailable' });
    }

    return {
      trips: result.rows.map(trip => ({
        ...trip,
        description: trip.slug === 'archive-search-party'
          ? `${trip.description} — ${flags.get('A05')}`
          : trip.description,
        travel_tip: tips.get(trip.slug) ?? null
      }))
    };
  });
}
