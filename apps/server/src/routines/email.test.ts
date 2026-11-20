import { expect, it } from 'vitest';
import { routineMessage } from './email.js';

it('escapes hostile body text, routine names, and owner names before adding email markup', () => {
  const message = routineMessage(
    {
      to: ['reader@example.test'],
      subject: 'Update\r\nInjected\tHeader',
      body: ' <script>"body" & \'text\'</script>\r\nNext line\r\n\r\n<img src=x onerror=alert(1)> ',
    },
    'reader@example.test',
    { name: '<svg onload="run()"> & \'routine\'', ownerName: '</p><script>"owner" & \'name\'</script>' },
  );
  expect(message.subject).toBe('Update Injected Header');
  expect(message.html).toBe(
    '<div><p>&lt;script&gt;&quot;body&quot; &amp; &#39;text&#39;&lt;/script&gt;<br>Next line</p>' +
      '<p>&lt;img src=x onerror=alert(1)&gt;</p><hr><p>Rio sent this for “' +
      '&lt;svg onload=&quot;run()&quot;&gt; &amp; &#39;routine&#39;,” a routine ' +
      '&lt;/p&gt;&lt;script&gt;&quot;owner&quot; &amp; &#39;name&#39;&lt;/script&gt; set up in Riosoma.</p></div>',
  );
  expect(message.text).toContain('<script>"body" & \'text\'</script>');
});
