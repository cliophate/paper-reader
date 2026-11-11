// Synthetic malformed markup. No account data or external fetches.
export const cleanupInputs = {
  enclosure: count => '<figure class="enclosure"><a href="https://youtube.com/watch?v=x">'.repeat(count),
  hero: count => '<post-hero>x'.repeat(count),
  footer: count => '<p>The post <a>story appeared first on <a>site'.repeat(count),
  image: count => 'src="<a href="https://example.test/image">'.repeat(count),
  deep: count => '<div>'.repeat(count) + '<p>Deep story</p>' + '</div>'.repeat(count),
  nestedParagraphs: count => '<p>The post <a>story</a><span>'.repeat(count)
    + '<p>Inner story</p>' + '<a>site</a></span></p>'.repeat(count),
}
