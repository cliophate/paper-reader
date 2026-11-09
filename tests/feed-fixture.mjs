import http from 'node:http'

const date = new Date().toUTCString()
http.createServer((request, response) => {
  if (!['/feed.xml', '/repaired.xml'].includes(request.url)) { response.writeHead(404).end(); return }
  response.setHeader('Content-Type', 'application/rss+xml')
  response.end(`<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Synthetic release feed</title><link>https://example.test/</link><description>Disposable integration data</description>
    ${[1, 2].map(n => `<item><guid>synthetic-release-${n}</guid><title>Synthetic compositor story ${n}</title>
    <link>https://example.test/article/${n}</link><pubDate>${date}</pubDate>
    <description><![CDATA[<p>Compositor article ${n}, generated only for the release integration test.</p>]]></description></item>`).join('')}
    </channel></rss>`)
}).listen(8080, '0.0.0.0')
