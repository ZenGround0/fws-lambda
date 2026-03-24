// Adapted from https://github.com/aidan46/WASM-CommP/blob/main/src/zero_reader.rs
//
// Reader that pads the inner reader with zeroes up to a given total size.

use std::io::Read;

pub struct ZeroPaddingReader<R: Read> {
    inner: R,
    remaining: u64,
}

impl<R: Read> ZeroPaddingReader<R> {
    pub fn new(inner: R, total_size: u64) -> Self {
        Self {
            inner,
            remaining: total_size,
        }
    }
}

impl<R: Read> Read for ZeroPaddingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }

        let to_read = buf.len().min(self.remaining as usize);
        let read = self.inner.read(&mut buf[..to_read])?;

        // Incomplete read doesn't mean that we need to pad it yet.
        if read > 0 {
            self.remaining -= read as u64;
            return Ok(read);
        }

        // Inner reader is exhausted, zero-pad the rest.
        buf[..to_read].fill(0);
        self.remaining -= to_read as u64;
        Ok(to_read)
    }
}
