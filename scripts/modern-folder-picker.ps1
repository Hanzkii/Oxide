param(
    [string]$InitialDir = ""
)

$source = @"
using System;
using System.Runtime.InteropServices;

namespace OxideNative {
    public class FolderPicker {
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        [ComImport]
        [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
        private class FileOpenDialogRCW {}

        [ComImport]
        [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IFileOpenDialog {
            [PreserveSig] int Show(IntPtr parent);
            void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
            void SetFileTypeIndex(uint iFileType);
            void GetFileTypeIndex(out uint piFileType);
            void Advise(IntPtr pfde, out uint pdwCookie);
            void Unadvise(uint dwCookie);
            void SetOptions(uint fos);
            void GetOptions(out uint fos);
            void SetDefaultFolder(IShellItem psi);
            void SetFolder(IShellItem psi);
            void GetFolder(out IShellItem ppsi);
            void GetCurrentSelection(out IShellItem ppsi);
            void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
            void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
            void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
            void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
            void GetResult(out IShellItem ppsi);
            void AddPlace(IShellItem psi, int fdap);
            void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
            void Close(int hr);
            void SetClientGuid(ref Guid guid);
            void ClearClientData();
            void SetFilter(IntPtr pFilter);
            void GetResults(out IntPtr ppenum);
            void GetSelectedItems(out IntPtr ppsai);
        }

        [ComImport]
        [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItem {
            void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
            void GetParent(out IShellItem ppsi);
            void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
            void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
            void Compare(IShellItem psi, uint hint, out int piOrder);
        }

        public static string PickFolder(string initialFolder, string title) {
            try {
                var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
                // FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_NOCHANGEDIR = 0x8
                uint options = 0x20 | 0x40 | 0x8;
                dialog.SetOptions(options);

                if (!string.IsNullOrEmpty(title)) {
                    dialog.SetTitle(title);
                }

                if (!string.IsNullOrEmpty(initialFolder) && System.IO.Directory.Exists(initialFolder)) {
                    Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                    IShellItem folderItem;
                    if (SHCreateItemFromParsingName(initialFolder, IntPtr.Zero, ref iid, out folderItem) == 0 && folderItem != null) {
                        dialog.SetFolder(folderItem);
                    }
                }

                IntPtr owner = GetForegroundWindow();
                if (dialog.Show(owner) == 0) {
                    IShellItem result;
                    dialog.GetResult(out result);
                    if (result != null) {
                        string path;
                        result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
                        return path;
                    }
                }
            } catch {}
            return null;
        }
    }
}
"@

$compiled = $false
try {
    Add-Type -TypeDefinition $source -ErrorAction Stop
    $compiled = $true
} catch {}

$res = $null
if ($compiled) {
    try {
        $res = [OxideNative.FolderPicker]::PickFolder($InitialDir, "Select Project Folder - Oxide Studio")
    } catch {}
}

if ([string]::IsNullOrEmpty($res)) {
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        $dialog = New-Object System.Windows.Forms.OpenFileDialog
        $dialog.Title = "Select Project Folder - Oxide Studio (Select any file inside or open folder)"
        $dialog.ValidateNames = $false
        $dialog.CheckFileExists = $false
        $dialog.CheckPathExists = $true
        $dialog.FileName = "Select Folder"
        if (![string]::IsNullOrEmpty($InitialDir) -and (Test-Path $InitialDir)) {
            $dialog.InitialDirectory = $InitialDir
        }
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $res = [System.IO.Path]::GetDirectoryName($dialog.FileName)
        }
    } catch {}
}

if (![string]::IsNullOrEmpty($res)) {
    Write-Output $res
}
