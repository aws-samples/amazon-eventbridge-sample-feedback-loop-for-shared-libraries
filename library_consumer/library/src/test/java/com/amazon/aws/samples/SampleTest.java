package com.amazon.aws.samples;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

/**
 * Sample Test which includes a call to the Shared Library. If the shared library's API changes
 * this test will not compile. If its behaviour changes this test should break.
 */
public class SampleTest {

    @Test
    public void testSharedLibrary() {
        String message = new SharedLibraryClass().sharedLibraryMethod();
        assertEquals("Hello World", message);
    }
}
