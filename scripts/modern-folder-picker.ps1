param(
    [string]$InitialDir = ""
)

$source = @"
using System;
using System.Runtime.InteropServices;

namespace OxideNative {
    public class ModernFolderPicker {
        [DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out object ppv);

        [ComImport]
        [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW {}

        [ComImport]
        [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes();
            void SetFileTypeIndex();
            void GetFileTypeIndex();
            void Advise();
            void Unadvise();
            void SetOptions(uint fos);
            void GetOptions(out uint fos);
            void SetDefaultFolder(object psi);
            void SetFolder(object psi);
            void GetFolder(out object ppsi);
            void GetCurrentSelection(out object ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
            void AddPlace();
            void SetDefaultExtension();
            void Close();
            void SetClientGuid();
            void ClearClientData();
            void SetFilter();
            void GetResults();
            void GetSelectedItems();
        }

        [ComImport]
        [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IShellItem {
            void BindToHandler();
            void GetParent();
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes();
            void Compare();
        }

        public static string SelectFolder(string title, string initialDir) {
            var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            // FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_NOCHANGEDIR = 0x8
            uint options = 0x00000020 | 0x00000040 | 0x00000008;
            dialog.SetOptions(options);

            if (!string.IsNullOrEmpty(title)) {
                dialog.SetTitle(title);
            }
            if (!string.IsNullOrEmpty(initialDir) && System.IO.Directory.Exists(initialDir)) {
                Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                object item;
                if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out item) == 0) {
                    dialog.SetFolder(item);
                }
            }

            int hr = dialog.Show(IntPtr.Zero);
            if (hr == 0) {
                IShellItem result;
                dialog.GetResult(out result);
                string path;
                result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
                return path;
            }
            return null;
        }
    }
}
"@

Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue

$res = [OxideNative.ModernFolderPicker]::SelectFolder("Select Project Folder for Oxide Studio", $InitialDir)
if (![string]::IsNullOrEmpty($res)) {
    Write-Output $res
}
