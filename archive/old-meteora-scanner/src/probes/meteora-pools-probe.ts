const SHYFT_API_KEY = process.env.SHYFT_API_KEY;

const POOL =
    "5fjmuEN72LQeo9NjvhLyQTV3ezyNgQqUXzSXskD2SCcy";

if (!SHYFT_API_KEY) {
    throw new Error("SHYFT_API_KEY belum di-set");
}

async function main() {
    const query = `
    query MyQuery {
      meteora_dlmm_Position(
        where: {lbPair: {_eq: "${POOL}"}}
      ) {
        lbPair
        owner
        pubkey
      }

      meteora_dlmm_PositionV2(
        where: {lbPair: {_eq: "${POOL}"}}
      ) {
        lbPair
        owner
        pubkey
      }
    }
  `;

    const response = await fetch(
        `https://programs.shyft.to/v0/graphql/accounts?api_key=${SHYFT_API_KEY}&network=mainnet-beta`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                query,
                variables: {},
                operationName: "MyQuery",
            }),
        }
    );

    const data = await response.json();

    console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);