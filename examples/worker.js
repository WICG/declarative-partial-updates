onmessage = async ({ data: { stream } }) => {
  const writer = stream.getWriter();
  let i = 0;
  while (i < 10) {
    await writer.write(`<p>${++i}</p>`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  writer.close();
}