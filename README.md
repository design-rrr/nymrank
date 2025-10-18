# NymRank

A Nostr-based reputation and name protection system using committee-based ranking.

## Committee Members

The system tracks delegation events from these initial committee members:

- **justin**: `3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088`
- **straycat**: `e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f`
- **vinny**: `2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331`

These keys are used to:
- Subscribe to delegation events (kind 10040) from committee members
- Track service key delegations for ranking
- Process ranking events (kind 30382) from delegated service keys
- Compute averaged rankings across committee members

## Available Scripts

In the project directory, you can run:

### `npm run dev`

To start the app in dev mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

### `npm start`

For production mode

### `npm run test`

Run the test cases.

## Learn More

To learn Fastify, check out the [Fastify documentation](https://fastify.dev/docs/latest/).
