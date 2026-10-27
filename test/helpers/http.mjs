// Windows can allocate an ephemeral port that Fetch blocks (for example 6000).
// Check the actual transport rather than maintaining a second forbidden-port list.
export async function listenForFetch(server) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((resolve, reject) => {
      const onError = error => { server.off('listening', onListen); reject(error); };
      const onListen = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(0, '127.0.0.1');
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      return origin;
    } catch (error) {
      await new Promise(resolve => server.close(resolve));
      if (error.cause?.message !== 'bad port') throw error;
    }
  }
  throw new Error('Could not allocate a Fetch-compatible loopback port');
}
