// A simple WASM job that computes SHA-256 over the input data.
// Convention: input at memory offset 0, output written after input.
// Returns output length.
//
// Output format: 32-byte SHA-256 hash followed by zero padding to 128 bytes.
// The padding ensures the output meets Filecoin's minimum piece size (127 bytes).

use sha2::{Sha256, Digest};

const OUTPUT_SIZE: usize = 128;

#[no_mangle]
pub extern "C" fn process(input_ptr: i32, input_len: i32) -> i32 {
    let input = unsafe {
        core::slice::from_raw_parts(input_ptr as *const u8, input_len as usize)
    };

    let hash = Sha256::digest(input);

    // Write output: 32-byte hash + zero padding to OUTPUT_SIZE.
    let output_ptr = (input_ptr + input_len) as *mut u8;
    unsafe {
        // Write hash.
        core::ptr::copy_nonoverlapping(hash.as_ptr(), output_ptr, 32);
        // Zero-pad the rest.
        core::ptr::write_bytes(output_ptr.add(32), 0u8, OUTPUT_SIZE - 32);
    }

    OUTPUT_SIZE as i32
}
